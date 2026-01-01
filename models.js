const mongoose = require('mongoose');
const user = new mongoose.Schema({
  uid: {type: Number, unique: true},
  balance: {type: Number, default: 0},
  refEarn: {type: Number, default: 0},
  ref: Number,
  ref2: Number,
  lastBonus: Number
}, {versionKey: false});

const invoice = new mongoose.Schema({
  iid: String,
  uid: Number,
  bet: Number,
  side: String,
  status: {type: String, default: 'pending'}
}, {versionKey: false});

const slotRound = new mongoose.Schema({
  uid: Number,
  bet: Number,
  invoiceId: String,
  reels: [],
  paid: {type: Boolean, default: false}
}, {versionKey: false});

module.exports = {
  User: mongoose.model('User', user),
  Invoice: mongoose.model('Invoice', invoice),
  SlotRound: mongoose.model('SlotRound', slotRound)
};