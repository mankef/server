require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

// ===== КРИТИЧЕСКИЙ CORS FIX =====
const ALLOWED_ORIGINS = [
    'https://miniapp-sigma-roan.vercel.app',
    'http://localhost:3000',
    'https://localhost:3000'
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bot-Token');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Безопасность
app.use(require('helmet')({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
app.use(require('express-rate-limit')({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, error: 'Too many requests' }
}));

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ =====
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('[✓] MongoDB connected'))
.catch(err => {
    console.error('[✗] MongoDB error:', err.message);
    process.exit(1);
});

// ===== МОДЕЛИ (ВНУТРИ ФАЙЛА) =====
const User = mongoose.model('User', new mongoose.Schema({
    uid: { type: Number, required: true, unique: true, index: true },
    balance: { type: Number, default: 0, min: 0 },
    refEarn: { type: Number, default: 0, min: 0 },
    ref: { type: Number, index: true },
    ref2: { type: Number, index: true },
    lastBonus: { type: Number, default: 0 },
    totalDeposited: { type: Number, default: 0, min: 0 },
    totalWithdrawn: { type: Number, default: 0, min: 0 },
    lastCheckUrl: { type: String },
    lastWithdrawalAt: { type: Date },
    totalGames: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalWagered: { type: Number, default: 0, min: 0 },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false, timestamps: true }));

const Invoice = mongoose.model('Invoice', new mongoose.Schema({
    iid: { type: String, required: true, unique: true, index: true },
    uid: { type: Number, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    type: { type: String, enum: ['deposit', 'withdraw'], required: true },
    status: { type: String, enum: ['pending', 'paid', 'expired', 'active', 'cancelled'], default: 'pending', index: true },
    refCode: { type: Number, index: true },
    payload: { type: String },
    createdAt: { type: Date, default: Date.now },
    paidAt: { type: Date },
    expiresAt: { type: Date, index: true }
}, { versionKey: false, timestamps: true }));

const SlotRound = mongoose.model('SlotRound', new mongoose.Schema({
    uid: { type: Number, required: true, index: true },
    bet: { type: Number, required: true, min: 0 },
    serverSeed: { type: String, required: true },
    serverHash: { type: String, required: true },
    clientSeed: { type: String },
    reels: { type: [[Number]], default: [] },
    win: { type: Number, default: 0 },
    finished: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false, timestamps: true }));

const CoinflipGame = mongoose.model('CoinflipGame', new mongoose.Schema({
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
}, { versionKey: false, timestamps: true }));

const Settings = mongoose.model('Settings', new mongoose.Schema({
    houseEdge: { type: Number, default: 0.05, min: 0, max: 0.5 },
    maintenanceMode: { type: Boolean, default: false },
    minDeposit: { type: Number, default: 0.01 },
    minWithdrawal: { type: Number, default: 0.2 }
}, { versionKey: false }), 'settings');

// ===== КОНФИГУРАЦИЯ =====
const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const SERVER_URL = process.env.SERVER_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');

console.log('[i] CRYPTO_TOKEN:', CRYPTO_TOKEN ? 'SET ✓' : 'NOT SET ✗');
console.log('[i] SERVER_URL:', SERVER_URL);

// ===== КОРНЕВЫЕ ЭНДПОИНТЫ =====
app.get('/', (req, res) => res.json({ 
    success: true, 
    service: 'SPIND BET API',
    crypto: CRYPTO_TOKEN ? 'configured' : 'missing'
}));

app.get('/health', (req, res) => res.status(200).json({
    success: true,
    status: 'healthy',
    db: mongoose.connection.readyState === 1
}));

// ===== СТАТИСТИКА (НЕДОСТАЮЩИЙ РОУТ) =====
app.get('/stats/global', async (req, res) => {
    try {
        const [totalUsers, totalDeposited, totalWithdrawn, activeUsers] = await Promise.all([
            User.countDocuments(),
            User.aggregate([{ $group: { _id: null, total: { $sum: '$totalDeposited' } } }]),
            User.aggregate([{ $group: { _id: null, total: { $sum: '$totalWithdrawn' } } }]),
            User.countDocuments({ lastBonus: { $gt: Date.now() - 24 * 60 * 60 * 1000 } })
        ]);

        res.json({
            success: true,
            stats: {
                users: { total: totalUsers, active24h: activeUsers },
                financial: {
                    totalDeposited: totalDeposited[0]?.total || 0,
                    totalWithdrawn: totalWithdrawn[0]?.total || 0,
                    houseProfit: (totalDeposited[0]?.total || 0) - (totalWithdrawn[0]?.total || 0)
                }
            }
        });
    } catch (error) {
        console.error('[STATS ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to load global stats' });
    }
});

// ===== ПОЛЬЗОВАТЕЛИ =====
app.post('/user/register', async (req, res) => {
    try {
        const { uid, refCode } = req.body;
        if (!uid || typeof uid !== 'number') return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        console.log(`[REGISTER] User ${uid}${refCode ? ` ref: ${refCode}` : ''}`);
        
        const user = await User.findOneAndUpdate(
            { uid }, 
            {}, 
            { upsert: true, new: true, runValidators: true }
        );
        
        if (refCode && !user.ref && refCode !== uid) {
            const refUser = await User.findOne({ uid: refCode });
            if (refUser) {
                user.ref = refCode;
                if (refUser.ref && refUser.ref !== uid) user.ref2 = refUser.ref;
                await user.save();
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('[REGISTER ERROR]', error);
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

app.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        const user = await User.findOneAndUpdate(
            { uid }, 
            {}, 
            { upsert: true, new: true, runValidators: true }
        );
        
        res.json({
            success: true,
            balance: Number(user.balance) || 0,
            refCode: user.uid,
            refCount: await User.countDocuments({ ref: uid }),
            refEarn: Number(user.refEarn) || 0,
            lastBonus: user.lastBonus || 0,
            totalDeposited: Number(user.totalDeposited) || 0,
            lastCheckUrl: user.lastCheckUrl || ''
        });
        
    } catch (error) {
        console.error('[USER ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to load user' });
    }
});

// ===== ДЕПОЗИТ =====
app.post('/deposit', async (req, res) => {
    try {
        const { uid, amount, refCode } = req.body;
        
        console.log(`[DEPOSIT] UID: ${uid}, Amount: ${amount} USDT`);
        
        if (!uid || typeof uid !== 'number') return res.status(400).json({ success: false, error: 'Invalid UID' });
        if (!amount || amount < 0.01) return res.status(400).json({ success: false, error: 'Minimum: 0.01 USDT' });
        if (!CRYPTO_TOKEN) return res.status(503).json({ success: false, error: 'Payment unavailable' });
        
        const payload = JSON.stringify({ uid, refCode, timestamp: Date.now() });
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createInvoice',
            {
                asset: 'USDT',
                amount: String(amount),
                description: `SPIND BET Deposit: ${amount} USDT`,
                payload: payload,
                expires_in: 3600
            },
            { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } }
        );
        
        if (!data.ok) throw new Error(data.error?.description || 'Invoice failed');
        
        await Invoice.create({
            iid: data.result.invoice_id,
            uid,
            amount,
            type: 'deposit',
            refCode,
            status: 'pending',
            payload: payload,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 3600000)
        });
        
        res.json({
            success: true,
            invoiceUrl: data.result.pay_url,
            invoiceId: data.result.invoice_id
        });
        
    } catch (error) {
        console.error('[DEPOSIT ERROR]', error.response?.data || error.message);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || error.message
        });
    }
});

// ===== ПРОВЕРКА ДЕПОЗИТА =====
app.post('/check-deposit', async (req, res) => {
    try {
        const { invoiceId } = req.body;
        if (!invoiceId) return res.status(400).json({ success: false, error: 'Invoice ID required' });
        
        console.log(`[CHECK DEPOSIT] Invoice: ${invoiceId}`);
        
        const invoice = await Invoice.findOne({ iid: invoiceId });
        if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
        
        if (invoice.status === 'paid') {
            return res.json({ success: true, status: 'paid', amount: invoice.amount, message: 'Already credited' });
        }
        
        const { data } = await axios.get(
            'https://pay.crypt.bot/api/getInvoices',
            {
                params: { invoice_ids: invoiceId },
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        const invoiceData = data.result.items[0];
        if (!invoiceData) return res.status(404).json({ success: false, error: 'Invoice not found in Crypto Bot' });
        
        // FIX: Crypto Bot возвращает 'active' вместо 'pending'
        let status = invoiceData.status;
        if (status === 'active') status = 'pending';
        
        console.log(`[CHECK DEPOSIT] Status: ${status}`);
        
        if (status === 'paid' && invoice.status !== 'paid') {
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    const user = await User.findOneAndUpdate(
                        { uid: invoice.uid },
                        { $inc: { balance: invoice.amount, totalDeposited: invoice.amount } },
                        { upsert: true, new: true, session }
                    );
                    
                    if (invoice.refCode && invoice.refCode !== invoice.uid) {
                        const ref1 = await User.findOne({ uid: invoice.refCode }).session(session);
                        if (ref1) {
                            const refBonus = invoice.amount * 0.05;
                            ref1.balance += refBonus;
                            ref1.refEarn += refBonus;
                            await ref1.save({ session });
                        }
                    }
                    
                    invoice.status = 'paid';
                    invoice.paidAt = new Date();
                    await invoice.save({ session });
                });
                await session.endSession();
                
                const user = await User.findOne({ uid: invoice.uid });
                res.json({ success: true, status: 'paid', amount: invoice.amount, newBalance: user.balance });
            } catch (error) {
                await session.endSession();
                throw error;
            }
        } else {
            if (status !== invoice.status) {
                invoice.status = status;
                await invoice.save();
            }
            
            res.json({ success: true, status: status });
        }
        
    } catch (error) {
        console.error('[CHECK DEPOSIT ERROR]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== ВЫВОД =====
app.post('/withdraw', async (req, res) => {
    try {
        const { uid, amount } = req.body;
        
        console.log(`[WITHDRAW] UID: ${uid}, Amount: ${amount}`);
        
        if (!uid || typeof uid !== 'number') return res.status(400).json({ success: false, error: 'Invalid UID' });
        if (!amount || amount < 0.2) return res.status(400).json({ success: false, error: 'Minimum: 0.20 USDT' });
        if (!CRYPTO_TOKEN) return res.status(503).json({ success: false, error: 'Payment unavailable' });
        
        const user = await User.findOne({ uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.balance < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });
        
        const spendId = `withdraw_${uid}_${Date.now()}`;
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createCheck',
            {
                asset: 'USDT',
                amount: String(amount.toFixed(2)),
                pin_to_user_id: uid,
                description: `SPIND BET Withdrawal for user ${uid}`,
                payload: spendId
            },
            { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } }
        );
        
        if (!data.ok) throw new Error(data.error?.description || 'Check failed');
        
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                user.balance -= amount;
                user.totalWithdrawn += amount;
                user.lastCheckUrl = data.result.bot_check_url;
                user.lastWithdrawalAt = new Date();
                await user.save({ session });
                
                await Invoice.create([{
                    iid: data.result.check_id,
                    uid,
                    amount,
                    type: 'withdraw',
                    status: 'paid',
                    paidAt: new Date()
                }], { session });
            });
            await session.endSession();
            
            res.json({ success: true, amount, newBalance: user.balance, checkUrl: data.result.bot_check_url });
        } catch (error) {
            await session.endSession();
            throw error;
        }
        
    } catch (error) {
        console.error('[WITHDRAW ERROR]', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ===== РЕФЕРАЛЬНАЯ СТАТИСТИКА =====
app.get('/ref/stats/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        const [directRefs, level2Refs, user] = await Promise.all([
            User.find({ ref: uid }).select('uid totalDeposited balance createdAt').lean(),
            User.find({ ref2: uid }).select('uid totalDeposited balance createdAt').lean(),
            User.findOne({ uid })
        ]);
        
        const directDeposits = directRefs.reduce((sum, u) => sum + (u.totalDeposited || 0), 0);
        const level2Deposits = level2Refs.reduce((sum, u) => sum + (u.totalDeposited || 0), 0);
        
        res.json({
            success: true,
            stats: {
                directCount: directRefs.length,
                level2Count: level2Refs.length,
                totalEarned: user?.refEarn || 0,
                directDeposits,
                level2Deposits,
                directRefs: directRefs.map(r => ({ uid: r.uid, deposited: r.totalDeposited || 0 })),
                level2Refs: level2Refs.map(r => ({ uid: r.uid, deposited: r.totalDeposited || 0 }))
            }
        });
        
    } catch (error) {
        console.error('[REF STATS ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to load referral stats' });
    }
});

// ===== БОНУС =====
app.post('/bonus', async (req, res) => {
    try {
        const { uid, now } = req.body;
        if (!uid || typeof uid !== 'number') return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        await User.updateOne({ uid }, { $set: { lastBonus: now } }, { runValidators: true });
        res.json({ success: true });
    } catch (error) {
        console.error('[BONUS ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to update bonus' });
    }
});

// ===== ПОЛЬЗОВАТЕЛЬСКАЯ СТАТИСТИКА =====
app.get('/stats/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        const user = await User.findOne({ uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        
        const slotsStats = await SlotRound.aggregate([
            { $match: { uid, finished: true } },
            { $group: { _id: null, totalWagered: { $sum: '$bet' }, totalWins: { $sum: '$win' } } }
        ]);
        
        const coinflipStats = await CoinflipGame.aggregate([
            { $match: { uid, finished: true } },
            { $group: { _id: null, totalWagered: { $sum: '$bet' }, totalWins: { $sum: '$win' }, totalGames: { $sum: 1 } } }
        ]);
        
        res.json({
            success: true,
            stats: {
                balance: user.balance,
                totalDeposited: user.totalDeposited || 0,
                totalWithdrawn: user.totalWithdrawn || 0,
                refEarn: user.refEarn || 0,
                slots: {
                    totalWagered: slotsStats[0]?.totalWagered || 0,
                    totalWins: slotsStats[0]?.totalWins || 0
                },
                coinflip: {
                    totalWagered: coinflipStats[0]?.totalWagered || 0,
                    totalWins: coinflipStats[0]?.totalWins || 0,
                    totalGames: coinflipStats[0]?.totalGames || 0
                }
            }
        });
        
    } catch (error) {
        console.error('[USER STATS ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to load user statistics' });
    }
});

// ===== АДМИН РОУТЫ =====
const adminLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many admin requests' }
});

app.use('/admin', adminLimiter);

app.post('/admin/set-edge', async (req, res) => {
    try {
        const { edge } = req.body;
        const secret = req.headers['x-admin-secret'];
        if (!secret || secret !== BOT_TOKEN) return res.status(403).json({ success: false, error: 'Access denied' });
        
        if (typeof edge !== 'number' || edge < 0 || edge > 0.3) {
            return res.status(400).json({ success: false, error: 'Edge must be 0-0.3' });
        }
        
        await Settings.updateOne({}, { houseEdge: edge }, { upsert: true, runValidators: true });
        res.json({ success: true, houseEdge: edge });
    } catch (error) {
        console.error('[SET EDGE ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to update house edge' });
    }
});

app.get('/admin/stats', async (req, res) => {
    try {
        const secret = req.headers['x-admin-secret'];
        if (!secret || secret !== BOT_TOKEN) return res.status(403).json({ success: false, error: 'Access denied' });
        
        const [totalUsers, totalDeposited, topReferrers] = await Promise.all([
            User.countDocuments(),
            User.aggregate([{ $group: { _id: null, total: { $sum: '$totalDeposited' } } }]),
            User.find().sort({ refEarn: -1 }).limit(10).select('uid refEarn').lean()
        ]);
        
        res.json({
            success: true,
            totalUsers,
            totalDeposited: totalDeposited[0]?.total || 0,
            topReferrers: topReferrers.map(u => ({ uid: u.uid, refEarn: u.refEarn }))
        });
        
    } catch (error) {
        console.error('[ADMIN STATS ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to load statistics' });
    }
});

// ===== ОШИБКИ =====
app.use((error, req, res, next) => {
    console.error('[UNHANDLED ERROR]', error);
    res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
});

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[✓] Server running on port ${PORT}`);
    console.log(`[i] CORS enabled for: ${ALLOWED_ORIGINS.join(', ')}`);
});

module.exports = app;
