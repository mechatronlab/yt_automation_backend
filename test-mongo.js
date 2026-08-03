const mongoose = require('mongoose');
require('dotenv').config();

async function test() {
  console.log('Connecting to:', process.env.MONGODB_URI);
  try {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('Connected successfully in', Date.now() - start, 'ms');
    
    console.log('Listing collection names...');
    const collections = await mongoose.connection.db.listCollections().toArray();
    console.log('Collections:', collections.map(c => c.name));
    
    await mongoose.disconnect();
    console.log('Disconnected.');
  } catch (err) {
    console.error('Connection failed:', err);
  }
}

test();
