const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    uid: { type: Number, required: true, unique: true, index: true },
    balance: { type: Number, default: 0, min: 0 },
    refEarn: { type: Number, default: 0, min: 0 },
    ref: { type: Number, index: true },
    ref2: { type: Number, index: true },
    lastBonus: { type: Number, default: 0 },
    totalDeposited: { type: Number, default: 0, min: 0 },
    totalWithdrawn: { type: Number, default: 0, min: 0 },
    lastCheckUrl: { type: String, validate: v => !v || v.startsWith('https://') },
    lastWithdrawalAt: { type: Date },
    totalGames: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalWagered: { type: Number, default: 0, min: 0 },
    createdAt: { type: Date, default: Date.now, index: true }
}, { versionKey: false, timestamps: true });

userSchema.index({ createdAt: -1 });
userSchema.index({ ref: 1, balance: -1 });

const invoiceSchema = new mongoose.Schema({
    iid: { type: String, required: true, unique: true, index: true },
    uid: { type: Number, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    type: { type: String, enum: ['deposit', 'withdraw'], required: true },
    status: { type: String, enum: ['pending', 'paid', 'expired', 'cancelled'], default: 'pending', index: true },
    refCode: { type: Number, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    paidAt: { type: Date },
    expiresAt: { type: Date, index: true }
}, { versionKey: false, timestamps: true });

const slotRoundSchema = new mongoose.Schema({
    uid: { type: Number, required: true, index: true },
    bet: { type: Number, required: true, min: 0 },
    serverSeed: { type: String, required: true },
    serverHash: { type: String, required: true },
    clientSeed: { type: String },
    reels: { type: [[Number]], default: [] },
    win: { type: Number, default: 0 },
    finished: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false, timestamps: true });

const coinflipGameSchema = new mongoose.Schema({
    uid: { type: Number, required: true, index: true },
    bet: { type: Number, required: true, min: 0 },
    choice: { type: String, enum: ['heads', 'tails'], required: true },
    serverSeed: { type: String, required: true },
    serverHash: { type: String, required: true },
    clientSeed: { type: String },
    result: { type: String, enum: ['heads', 'tails'] },
    win: { type: Number, default: 0 },
    finished: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false, timestamps: true });

const settingsSchema = new mongoose.Schema({
    houseEdge: { type: Number, default: 0.05, min: 0, max: 0.3 },
    maintenanceMode: { type: Boolean, default: false },
    minDeposit: { type: Number, default: 0.01 },
    minWithdrawal: { type: Number, default: 0.2 }
}, { versionKey: false });

module.exports = {
    User: mongoose.model('User', userSchema),
    Invoice: mongoose.model('Invoice', invoiceSchema),
    Settings: mongoose.model('Settings', settingsSchema, 'settings'),
    SlotRound: mongoose.model('SlotRound', slotRoundSchema),
    CoinflipGame: mongoose.model('CoinflipGame', coinflipGameSchema)
};
