require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const app = express();

// ===== НАСТРОЙКА БЕЗОПАСНОСТИ =====
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// ===== RATE LIMITING =====
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, message: { success: false, error: 'Too many requests' } }));
app.use('/admin', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { success: false, error: 'Too many admin requests' } }));

// ===== ПОДКЛЮЧЕНИЕ К БАЗЕ =====
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
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
console.log('[i] SERVER_URL:', SERVER_URL);
console.log('[i] ADMIN_ID:', ADMIN_ID);

// ===== РОУТЫ =====
app.use('/', require('./routes/slots'));
app.use('/admin', require('./routes/admin'));
app.use('/coinflip', require('./routes/coinflip'));
app.use('/stats', require('./routes/stats'));

// ===== КОРНЕВОЙ ЭНДПОИНТ =====
app.get('/', (req, res) => res.json({ 
    success: true, 
    service: 'SPIND BET API',
    crypto: CRYPTO_TOKEN ? 'configured' : 'missing',
    server: SERVER_URL,
    timestamp: new Date().toISOString()
}));

app.get('/health', (req, res) => res.status(200).json({
    success: true,
    status: 'healthy',
    crypto: !!CRYPTO_TOKEN,
    db: mongoose.connection.readyState === 1,
    timestamp: new Date().toISOString()
}));

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
        
        // Обработка реферала
        if (refCode && !user.ref && refCode !== uid) {
            const refUser = await User.findOne({ uid: refCode });
            if (refUser) {
                user.ref = refCode;
                if (refUser.ref && refUser.ref !== uid) user.ref2 = refUser.ref;
                await user.save();
                console.log(`[REGISTER] Referral: ${refCode} -> ${uid}`);
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('[REGISTER ERROR]', error);
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

// ===== ДЕПОЗИТ =====
app.post('/deposit', async (req, res) => {
    try {
        const { uid, amount, refCode } = req.body;
        
        console.log(`[DEPOSIT REQUEST] UID: ${uid}, Amount: ${amount} USDT`);
        
        // Валидация
        if (!uid || typeof uid !== 'number') return res.status(400).json({ success: false, error: 'Invalid user ID' });
        if (!amount || amount < 0.01) return res.status(400).json({ success: false, error: 'Minimum deposit: 0.01 USDT' });
        if (!CRYPTO_TOKEN) return res.status(503).json({ success: false, error: 'Payment service unavailable (no token)' });
        
        // Создание инвойса в Crypto Bot
        const payload = JSON.stringify({ uid, refCode, timestamp: Date.now() });
        
        console.log(`[DEPOSIT] Creating Crypto Bot invoice for ${amount} USDT...`);
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createInvoice',
            {
                asset: 'USDT',
                amount: String(amount),
                description: `SPIND BET Deposit: ${amount} USDT`,
                payload: payload,
                expires_in: 3600 // 1 час
            },
            {
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        // Проверка ответа
        if (!data.ok) {
            console.error('[DEPOSIT ERROR] Crypto Bot response:', data.error);
            throw new Error(data.error?.description || `Crypto Bot API error: ${JSON.stringify(data.error)}`);
        }
        
        console.log('[DEPOSIT SUCCESS] Invoice ID:', data.result.invoice_id);
        
        // Сохранение в базу
        await Invoice.create({
            iid: data.result.invoice_id,
            uid,
            amount,
            type: 'deposit',
            refCode,
            status: 'pending',
            payload: payload,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 3600000) // 1 час
        });
        
        res.json({
            success: true,
            invoiceUrl: data.result.pay_url,
            invoiceId: data.result.invoice_id,
            amount: amount,
            message: 'Invoice created successfully'
        });
        
    } catch (error) {
        console.error('[DEPOSIT ERROR]', error.response?.data || error.message);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || error.message || 'Failed to create invoice'
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
        if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found in DB' });
        
        if (invoice.status === 'paid') {
            return res.json({ 
                success: true,
                status: 'paid', 
                amount: invoice.amount, 
                message: 'Already credited'
            });
        }
        
        // Проверяем в Crypto Bot
        const { data } = await axios.get(
            'https://pay.crypt.bot/api/getInvoices',
            {
                params: { invoice_ids: invoiceId },
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        if (!data.ok) {
            console.error('[CHECK ERROR] Crypto Bot check failed:', data.error);
            throw new Error(data.error?.description || 'Failed to check invoice');
        }
        
        const invoiceData = data.result.items[0];
        if (!invoiceData) {
            return res.status(404).json({ success: false, error: 'Invoice not found in Crypto Bot' });
        }
        
        console.log(`[CHECK DEPOSIT] Status: ${invoiceData.status}`);
        
        if (invoiceData.status === 'paid' && invoice.status !== 'paid') {
            console.log('[CHECK DEPOSIT] Processing payment...');
            
            // Обрабатываем платеж в транзакции
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
                            console.log(`[REF] Level 1 bonus: ${refBonus} to ${ref1.uid}`);
                            
                            if (ref1.ref && ref1.ref !== invoice.uid) {
                                const ref2 = await User.findOne({ uid: ref1.ref }).session(session);
                                if (ref2) {
                                    const ref2Bonus = invoice.amount * 0.02;
                                    ref2.balance += ref2Bonus;
                                    ref2.refEarn += ref2Bonus;
                                    await ref2.save({ session });
                                    console.log(`[REF] Level 2 bonus: ${ref2Bonus} to ${ref2.uid}`);
                                }
                            }
                        }
                    }
                    
                    // Обновляем инвойс
                    invoice.status = 'paid';
                    invoice.paidAt = new Date();
                    await invoice.save({ session });
                    
                    console.log(`[DEPOSIT SUCCESS] User ${invoice.uid} credited ${invoice.amount} USDT`);
                });
                
                await session.endSession();
                
                res.json({
                    success: true,
                    status: 'paid',
                    amount: invoice.amount,
                    newBalance: (await User.findOne({ uid: invoice.uid })).balance,
                    message: 'Payment credited successfully'
                });
                
            } catch (error) {
                await session.endSession();
                throw error;
            }
        } else {
            // Обновляем статус если изменился
            if (invoiceData.status !== invoice.status) {
                invoice.status = invoiceData.status;
                await invoice.save();
            }
            
            res.json({ success: true, status: invoiceData.status, message: `Invoice ${invoiceData.status}` });
        }
        
    } catch (error) {
        console.error('[CHECK DEPOSIT ERROR]', error);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || error.message
        });
    }
});

// ===== ВЫВОД ЧЕКОМ =====
app.post('/withdraw', async (req, res) => {
    try {
        const { uid, amount } = req.body;
        
        console.log(`[WITHDRAW REQUEST] UID: ${uid}, Amount: ${amount} USDT`);
        
        // Валидация
        if (!uid || typeof uid !== 'number') return res.status(400).json({ success: false, error: 'Invalid user ID' });
        if (!amount || amount < 0.2) return res.status(400).json({ success: false, error: 'Minimum withdrawal: 0.20 USDT' });
        if (!CRYPTO_TOKEN) return res.status(503).json({ success: false, error: 'Payment service unavailable (no token)' });
        
        const user = await User.findOne({ uid });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        if (user.balance < amount) return res.status(400).json({ success: false, error: 'Insufficient balance' });
        
        console.log(`[WITHDRAW] Creating check for ${amount} USDT...`);
        
        // Создаем чек
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
            {
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        if (!data.ok) {
            console.error('[WITHDRAW ERROR] Crypto Bot response:', data.error);
            throw new Error(data.error?.description || `Crypto Bot API error: ${JSON.stringify(data.error)}`);
        }
        
        console.log('[WITHDRAW SUCCESS] Check ID:', data.result.check_id);
        
        // Обрабатываем вывод в транзакции
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
            
            // Уведомляем админа
            if (ADMIN_ID) {
                axios.post(
                    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                    {
                        chat_id: ADMIN_ID,
                        text: `📤 WITHDRAWAL\n\nUser: ${uid}\nAmount: ${amount} USDT\n\nCheck: ${data.result.bot_check_url}`
                    }
                ).catch(() => {});
            }
            
            res.json({
                success: true,
                amount,
                newBalance: user.balance,
                checkUrl: data.result.bot_check_url,
                message: 'Withdrawal created successfully'
            });
            
        } catch (error) {
            await session.endSession();
            throw error;
        }
        
    } catch (error) {
        console.error('[WITHDRAW ERROR]', error.response?.data || error.message);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || error.message || 'Withdrawal failed'
        });
    }
});

// ===== ПОЛУЧЕНИЕ ПОЛЬЗОВАТЕЛЯ =====
app.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) return res.status(400).json({ success: false, error: 'Invalid user ID' });
        
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
            lastCheckUrl: user.lastCheckUrl || '',
            message: 'User data loaded'
        });
        
    } catch (error) {
        console.error('[USER ERROR]', error);
        res.status(500).json({ success: false, error: 'Failed to load user', balance: 0 });
    }
});

// ===== ОБНОВЛЕНИЕ БОНУСА =====
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

// ===== РЕФЕРАЛЬНАЯ СТАТИСТИКА =====
app.get('/ref/stats/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        const [directRefs, level2Refs, user] = await Promise.all([
            User.find({ ref: uid }).select('uid totalDeposited balance').lean(),
            User.find({ ref2: uid }).select('uid totalDeposited balance').lean(),
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

// ===== ОБРАБОТКА ОШИБОК =====
app.use((error, req, res, next) => {
    console.error('[UNHANDLED ERROR]', error);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error',
        details: error.message
    });
});

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[✓] SPIND BET Server running on port ${PORT}`);
    console.log(`[i] Health check: ${SERVER_URL}/health`);
});

module.exports = app;
