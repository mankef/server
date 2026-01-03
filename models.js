const mongoose = require('mongoose');

// ===== СХЕМА ПОЛЬЗОВАТЕЛЯ =====
const userSchema = new mongoose.Schema({
    uid: {
        type: Number,
        required: true,
        unique: true,
        index: true,
        description: 'Telegram User ID'
    },
    balance: {
        type: Number,
        default: 0,
        min: [0, 'Balance cannot be negative'],
        index: true
    },
    refEarn: {
        type: Number,
        default: 0,
        min: [0, 'Ref earnings cannot be negative'],
        index: true
    },
    ref: {
        type: Number,
        ref: 'User',
        index: true,
        description: 'Who referred this user (Level 1)'
    },
    ref2: {
        type: Number,
        ref: 'User',
        index: true,
        description: 'Who referred the referrer (Level 2)'
    },
    lastBonus: {
        type: Number,
        default: 0,
        description: 'Timestamp of last daily bonus claim'
    },
    totalDeposited: {
        type: Number,
        default: 0,
        min: [0, 'Cannot be negative']
    },
    totalWithdrawn: {
        type: Number,
        default: 0,
        min: [0, 'Cannot be negative']
    },
    lastCheckUrl: {
        type: String,
        validate: {
            validator: function(v) {
                return !v || v.startsWith('https://');
            },
            message: 'Invalid URL format'
        }
    },
    lastWithdrawalAt: {
        type: Date,
        description: 'Last withdrawal timestamp'
    },
    totalGames: {
        type: Number,
        default: 0,
        min: [0, 'Cannot be negative']
    },
    totalWins: {
        type: Number,
        default: 0,
        min: [0, 'Cannot be negative']
    },
    totalWagered: {
        type: Number,
        default: 0,
        min: [0, 'Cannot be negative']
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { 
    versionKey: false,
    timestamps: true // createdAt, updatedAt
});

// Индексы для производительности
userSchema.index({ createdAt: -1 });
userSchema.index({ ref: 1, balance: -1 });
userSchema.index({ lastBonus: -1 });

// ===== СХЕМА ИНВОЙСОВ =====
const invoiceSchema = new mongoose.Schema({
    iid: {
        type: String,
        required: true,
        unique: true,
        index: true,
        description: 'Crypto Bot Invoice/Check ID'
    },
    uid: {
        type: Number,
        required: true,
        index: true,
        description: 'User ID'
    },
    amount: {
        type: Number,
        required: true,
        min: [0, 'Amount must be positive']
    },
    type: {
        type: String,
        enum: ['deposit', 'withdraw'],
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'expired', 'cancelled'],
        default: 'pending',
        index: true
    },
    refCode: {
        type: Number,
        index: true,
        description: 'Referral code used for this transaction'
    },
    payload: {
        type: String,
        description: 'Additional data for verification'
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    paidAt: {
        type: Date
    },
    expiresAt: {
        type: Date,
        index: true
    }
}, { versionKey: false, timestamps: true });

// Индексы для invoice
invoiceSchema.index({ uid: 1, createdAt: -1 });
invoiceSchema.index({ status: 1, createdAt: 1 });
invoiceSchema.index({ type: 1, status: 1 });

// ===== НАСТРОЙКИ СИСТЕМЫ =====
const settingsSchema = new mongoose.Schema({
    houseEdge: {
        type: Number,
        default: 0.05,
        min: [0, 'House edge cannot be negative'],
        max: [0.5, 'House edge too high']
    },
    maintenanceMode: {
        type: Boolean,
        default: false
    },
    minDeposit: {
        type: Number,
        default: 0.01
    },
    minWithdrawal: {
        type: Number,
        default: 0.2
    },
    botCommission: {
        type: Number,
        default: 0.01 // 1% commission on wins for referrals
    }
}, { versionKey: false });

// ===== СХЕМА РАУНДОВ СЛОТОВ =====
const slotRoundSchema = new mongoose.Schema({
    uid: {
        type: Number,
        required: true,
        index: true,
        description: 'User ID'
    },
    bet: {
        type: Number,
        required: true,
        min: [0, 'Bet cannot be negative']
    },
    serverSeed: {
        type: String,
        required: true,
        description: 'Server seed for provably fair'
    },
    serverHash: {
        type: String,
        required: true,
        description: 'SHA256 of server seed'
    },
    clientSeed: {
        type: String,
        description: 'Client seed provided by user'
    },
    reels: {
        type: [[Number]], // Массив массивов [ [1,2,3], [4,5,6], [7,8,9] ]
        default: []
    },
    win: {
        type: Number,
        default: 0,
        min: [0, 'Win cannot be negative']
    },
    finished: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { versionKey: false, timestamps: true });

slotRoundSchema.index({ uid: 1, createdAt: -1 });

// ===== СХЕМА ИГР COINFLIP =====
const coinflipGameSchema = new mongoose.Schema({
    uid: {
        type: Number,
        required: true,
        index: true,
        description: 'User ID'
    },
    bet: {
        type: Number,
        required: true,
        min: [0, 'Bet cannot be negative']
    },
    choice: {
        type: String,
        enum: ['heads', 'tails'],
        required: true,
        description: 'User choice'
    },
    serverSeed: {
        type: String,
        required: true,
        description: 'Server seed for provably fair'
    },
    serverHash: {
        type: String,
        required: true,
        description: 'SHA256 of server seed'
    },
    clientSeed: {
        type: String,
        description: 'Client seed provided by user'
    },
    result: {
        type: String,
        enum: ['heads', 'tails'],
        description: 'Actual result'
    },
    win: {
        type: Number,
        default: 0,
        min: [0, 'Win cannot be negative']
    },
    finished: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { versionKey: false, timestamps: true });

coinflipGameSchema.index({ uid: 1, createdAt: -1 });

// ===== ЭКСПОРТ =====
module.exports = {
    User: mongoose.model('User', userSchema),
    Invoice: mongoose.model('Invoice', invoiceSchema),
    Settings: mongoose.model('Settings', settingsSchema, 'settings'),
    SlotRound: mongoose.model('SlotRound', slotRoundSchema),
    CoinflipGame: mongoose.model('CoinflipGame', coinflipGameSchema)
};
