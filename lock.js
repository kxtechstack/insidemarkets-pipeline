// clearStuckLock.js
require('dotenv').config();
const { releaseLock } = require('./modules/queueManager');

const clear = async () => {
  await releaseLock('b61b4d3b-caeb-457b-9971-636c83688ee4', '205290a7-5eca-4b67-bea1-f5fabb94bdc1');
  console.log('Lock cleared.');
};

clear();