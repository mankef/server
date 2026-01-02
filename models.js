const mongoose = require('mongoose');

const user = new mongoose.Schema({
  uid: {type: Number, unique: true},
  balance: {type: Number, default: 0},
  refEarn: {type: Number, default: 0},
  ref: Number,
  ref2: Number,
  lastBonus: Number,
  totalDeposited: {type: Number, default: 0}
}, {versionKey: false});

const invoice = new mongoose.Schema({
  iid: String,
  uid: Number,
  amount: Number,
  type: {type: String, enum: ['deposit', 'withdraw']},
  status: {type: String, default: 'pending'},
  refCode: Number
}, {versionKey: false});

const slotRound = new mongoose.Schema({
  uid: Number,
  bet: Number,
  reels: [],
  win: Number,
  finished: {type: Boolean, default: false}
}, {versionKey: false});

const settings = new mongoose.Schema({
  houseEdge: {type: Number, default: 0.05}
}, {versionKey: false});

module.exports = {
  User: mongoose.model('User', user),
  Invoice: mongoose.model('Invoice', invoice),
  SlotRound: mongoose.model('SlotRound', slotRound),
  Settings: mongoose.model('Settings', settings, 'settings')
};
