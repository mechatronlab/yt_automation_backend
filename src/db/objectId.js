'use strict';

const crypto = require('crypto');

const generateObjectId = () => crypto.randomBytes(12).toString('hex');

class ObjectId {
  constructor(value) {
    this.value = value || generateObjectId();
  }

  toString() {
    return String(this.value);
  }

  toHexString() {
    return this.toString();
  }
}

module.exports = {
  generateObjectId,
  ObjectId,
  Types: {
    ObjectId,
  },
};
