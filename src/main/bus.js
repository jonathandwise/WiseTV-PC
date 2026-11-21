'use strict';
// App-wide event bus between main-process modules (and forwarded to the window).
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);
module.exports = bus;
