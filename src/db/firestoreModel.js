'use strict';

const { getFirestore } = require('../config/firebase');
const { generateObjectId } = require('./objectId');

const toIdString = (value) => {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (value._id != null) return String(value._id);
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
};

const matchesFilter = (doc, filter = {}) => {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return expected.some((clause) => matchesFilter(doc, clause));
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (expected.$in) {
        const actual = toIdString(doc[key]);
        return expected.$in.map(toIdString).includes(actual);
      }
      if (expected.$ne != null) {
        return toIdString(doc[key]) !== toIdString(expected.$ne);
      }
    }
    const actual = doc[key];
    if (actual == null && expected == null) return true;
    return toIdString(actual) === toIdString(expected);
  });
};

const parseSort = (sortExpr) => {
  if (!sortExpr) return null;
  const desc = String(sortExpr).startsWith('-');
  const field = desc ? String(sortExpr).slice(1) : String(sortExpr);
  return { field, dir: desc ? 'desc' : 'asc' };
};

const applyProjection = (doc, projection) => {
  if (!projection) return { ...doc };
  const include = {};
  const exclude = {};
  String(projection)
    .split(/\s+/)
    .filter(Boolean)
    .forEach((field) => {
      if (field.startsWith('-')) exclude[field.slice(1)] = true;
      else include[field] = true;
    });

  const out = { _id: doc._id };
  const keys = Object.keys(include).length ? Object.keys(include) : Object.keys(doc);
  keys.forEach((key) => {
    if (!exclude[key]) out[key] = doc[key];
  });
  return out;
};

class FirestoreDocument {
  constructor(model, data = {}, id = null) {
    this._model = model;
    this._id = id || data._id || data.id || null;
    Object.assign(this, data);
    if (this._id) this._id = String(this._id);
  }

  async save() {
    const now = new Date().toISOString();
    if (!this._id) {
      this._id = generateObjectId();
      if (!this.createdAt) this.createdAt = now;
    }
    this.updatedAt = now;
    const payload = this._model.serialize(this);
    await this._model.collection.doc(this._id).set(payload, { merge: true });
    return this;
  }

  async deleteOne() {
    if (!this._id) return;
    await this._model.collection.doc(this._id).delete();
  }

  toObject() {
    return { ...this._model.toPlain(this), _id: this._id };
  }

  toJSON() {
    return this.toObject();
  }

  // Mongoose compatibility — Firestore saves the full document on save().
  markModified() {
    return this;
  }
}

class Query {
  constructor(model, filter = {}) {
    this.model = model;
    this.filter = filter;
    this.projection = null;
    this.sortSpec = null;
    this.leanResult = false;
    this.populateSpec = null;
    this.limitCount = null;
    this.single = false;
    this.byId = filter._id != null && Object.keys(filter).length === 1;
  }

  select(projection) {
    this.projection = projection;
    return this;
  }

  sort(sortExpr) {
    this.sortSpec = parseSort(sortExpr);
    return this;
  }

  lean() {
    this.leanResult = true;
    return this;
  }

  populate(path, fields) {
    this.populateSpec = { path, fields };
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  async _fetchDocs() {
    let docs;
    if (this.byId) {
      const doc = await this.model._findByIdDirect(this.filter._id);
      docs = doc ? [doc] : [];
    } else {
      const snapshot = await this.model.collection.get();
      docs = snapshot.docs.map((doc) => this.model.hydrate(doc.id, doc.data()));
      if (Object.keys(this.filter).length) {
        docs = docs.filter((doc) => matchesFilter(doc, this.filter));
      }
    }

    if (this.sortSpec) {
      const { field, dir } = this.sortSpec;
      docs.sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = av > bv ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }

    if (this.limitCount != null) {
      docs = docs.slice(0, this.limitCount);
    }

    if (this.populateSpec) {
      docs = await Promise.all(docs.map((doc) => this.model.populateDoc(doc, this.populateSpec)));
    }

    return docs.map((doc) => {
      const plain = this.leanResult ? doc.toObject() : doc;
      return this.projection
        ? applyProjection(this.leanResult ? plain : doc.toObject(), this.projection)
        : plain;
    });
  }

  then(resolve, reject) {
    return this._fetchDocs()
      .then((docs) => (this.single ? resolve(docs[0] || null) : resolve(docs)), reject);
  }
}

class FirestoreModel {
  constructor(collectionName, options = {}) {
    this.collectionName = collectionName;
    this.populateMap = options.populateMap || {};
    this._collection = null;
  }

  get collection() {
    if (!this._collection) {
      this._collection = getFirestore().collection(this.collectionName);
    }
    return this._collection;
  }

  hydrate(id, data = {}) {
    const doc = new FirestoreDocument(this, { ...data, _id: id }, id);
    return doc;
  }

  serialize(doc) {
    const plain = this.toPlain(doc);
    delete plain._id;
    Object.keys(plain).forEach((key) => {
      if (plain[key] === undefined) delete plain[key];
    });
    return plain;
  }

  toPlain(doc) {
    const plain = {};
    Object.keys(doc).forEach((key) => {
      if (key === '_model' || key.startsWith('_')) return;
      plain[key] = doc[key];
    });
    return plain;
  }

  async populateDoc(doc, { path, fields }) {
    const refId = toIdString(doc[path]);
    if (!refId) return doc;

    const targetModel = this.populateMap[path];
    if (!targetModel) return doc;

    const related = await targetModel.findById(refId);
    if (!related) {
      doc[path] = null;
      return doc;
    }

    if (fields) {
      const allowed = fields.split(/\s+/).filter(Boolean);
      const nested = { _id: related._id };
      allowed.forEach((field) => {
        nested[field] = related[field];
      });
      doc[path] = nested;
    } else {
      doc[path] = related.toObject();
    }
    return doc;
  }

  find(filter = {}) {
    return new Query(this, filter);
  }

  findOne(filter = {}) {
    const query = new Query(this, filter);
    query.single = true;
    query.limitCount = 1;
    return query;
  }

  findById(id) {
    const query = new Query(this, { _id: id });
    query.single = true;
    query.limitCount = 1;
    return query;
  }

  async _findByIdDirect(id) {
    if (!id) return null;
    const doc = await this.collection.doc(toIdString(id)).get();
    if (!doc.exists) return null;
    return this.hydrate(doc.id, doc.data());
  }

  async create(data) {
    const doc = new FirestoreDocument(this, { ...data });
    await doc.save();
    return doc;
  }

  async countDocuments(filter = {}) {
    const docs = await this.find(filter);
    return docs.length;
  }

  async updateMany(filter, update = {}) {
    const docs = await this.find(filter);
    const updated = [];
    for (const item of docs) {
      const doc = item instanceof FirestoreDocument ? item : this.hydrate(item._id, item);
      if (update.$set) Object.assign(doc, update.$set);
      else Object.assign(doc, update);
      await doc.save();
      updated.push(doc);
    }
    return { modifiedCount: updated.length };
  }

  async findByIdAndUpdate(id, update = {}, options = {}) {
    const doc = await this._findByIdDirect(id);
    if (!doc) return null;
    Object.assign(doc, update);
    await doc.save();
    return options.new === false ? null : doc;
  }
}

module.exports = {
  FirestoreModel,
  FirestoreDocument,
  toIdString,
};
