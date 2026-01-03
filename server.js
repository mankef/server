require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();

// ===== КРИТИЧЕСКИЙ CORS FIX =====
const ALLOWED_ORIGINS = [
    'https://miniapp-sigma-roan.vercel.app',
    'https://server-production-b3d5.up.railway.app',
    'http://localhost:3000',
    'https://localhost:3000'
];

// Устанавливаем CORS заголовки ДО всех роутов
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bot-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    
    // Обрабатываем preflight OPTIONS запрос
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Базовая безопасность
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
app.use(rateLimit({
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

// ===== МОДЕЛИ =====
const { User, Invoice, Settings, SlotRound, CoinflipGame } = require('./models');

// ===== КОНФИГУРАЦИЯ =====
const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const SERVER_URL = process.env.SERVER_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');

console.log('[i] CRYPTO_TOKEN:', CRYPTO_TOKEN ? 'SET ✓' : 'NOT SET ✗');
console.log('[i] ALLOWED_ORIGINS:', ALLOWED_ORIGINS.join(', '));
console.log('[i] SERVER_URL:', SERVER_URL);

// ===== РОУТЫ =====
app.use('/', require('./routes/slots'));
app.use('/admin', require('./routes/admin'));
app.use('/coinflip', require('./routes/coinflip'));

// ===== КОРНЕВЫЕ ЭНДПОИНТЫ =====
app.get('/', (req, res) => res.json({ 
    success: true, 
    service: 'SPIND BET API',
    crypto: CRYPTO_TOKEN ? 'configured' : 'missing',
    cors: ALLOWED_ORIGINS,
    timestamp: new Date().toISOString()
}));

app.get('/health', (req, res) => res.status(200).json({
    success: true,
    status: 'healthy',
    crypto: !!CRYPTO_TOKEN,
    db: mongoose.connection.readyState === 1,
    timestamp: new Date().toISOString()
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

// ===== РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ =====
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

// ===== ПОЛУЧЕНИЕ ПОЛЬЗОВАТЕЛЯ =====
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

// ===== ПРОВЕРКА ДЕПОЗИТА (FIXED) =====
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
        
        // Проверяем в Crypto Bot
        const { data } = await axios.get(
            'https://pay.crypt.bot/api/getInvoices',
            {
                params: { invoice_ids: invoiceId },
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        const invoiceData = data.result.items[0];
        if (!invoiceData) return res.status(404).json({ success: false, error: 'Invoice not found in Crypto Bot' });
        
        // ✅ FIX: Крапiva Bot возвращает 'active' вместо 'pending'
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
                    
                    // Реферальные бонусы
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
            // Обновляем статус если изменился
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
            
            if (ADMIN_ID) {
                axios.post(
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                    { chat_id: ADMIN_ID, text: `📤 Withdrawal: User ${uid} - ${amount} USDT` }
                ).catch(() => {});
            }
            
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

// ===== НЕОБРАБОТАННЫЕ ОШИБКИ =====
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
