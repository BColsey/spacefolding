const listeners = require('./listeners');

function publishEvent(topic, payload) {
  return listeners.dispatch(topic, payload);
}

module.exports = { publishEvent };
