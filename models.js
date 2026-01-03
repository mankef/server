const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    uid: {
        type: Number,
        required: true,
        unique: true,
        index: true
    },
    balance: {
        type: Number,
        default: 0,
        min: 0
    },
    refEarn: {
        type: Number,
        default: 0,
        min: 0
    },
    ref: {
        type: Number,
        ref: 'User',
        index: true
    },
    ref2: {
        type: Number,
        ref: 'User',
        index: true
    },
    lastBonus: {
        type: Number,
        default: 0
    },
    totalDeposited: {
        type: Number,
        default: 0,
        min: 0
    },
    totalWithdrawn: {
        type: Number,
        default: 0,
        min: 0
    },
    lastCheckUrl: {
        type: String,
        validate: {
            validator: (v) => !v || v.startsWith('https://'),
            message: 'Invalid URL format'
        }
    },
    lastWithdrawalAt: {
        type: Date
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
}, { 
    versionKey: false,
    timestamps: true
});

userSchema.index({ createdAt: -1 });
userSchema.index({ 'ref': 1, 'balance': -1 });

const invoiceSchema = new mongoose.Schema({
    iid: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    uid: {
        type: Number,
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    type: {
        type: String,
        enum: ['deposit', 'withdraw'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'paid', 'expired', 'cancelled'],
        default: 'pending',
        index: true
    },
    refCode: {
        type: Number,
        index: true
    },
    payload: {
        type: String
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
}, { 
    versionKey: false,
    timestamps: true
});

invoiceSchema.index({ uid: 1, createdAt: -1 });
invoiceSchema.index({ status: 1, createdAt: 1 });

const settingsSchema = new mongoose.Schema({
    houseEdge: {
        type: Number,
        default: 0.05,
        min: 0,
        max: 0.3
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
    }
}, { 
    versionKey: false
});

module.exports = {
    User: mongoose.model('User', userSchema),
    Invoice: mongoose.model('Invoice', invoiceSchema),
    Settings: mongoose.model('Settings', settingsSchema, 'settings')
};
