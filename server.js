require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();

// Безопасность
app.use(helmet());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Admin rate limiting
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { success: false, error: 'Too many admin requests' },
});
app.use('/admin', adminLimiter);

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    maxPoolSize: 10,
})
.then(() => console.log('[SPIND BET] MongoDB connected'))
.catch(err => {
    console.error('[SPIND BET] MongoDB error:', err);
    process.exit(1);
});

// Models
const { User, Invoice, Settings, SlotRound, CoinflipGame } = require('./models');
const fair = require('./utils/fair');

// API Config
const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const SERVER_URL = process.env.SERVER_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');

// Routes
const slotsRouter = require('./routes/slots');
const adminRouter = require('./routes/admin');
const coinflipRouter = require('./routes/coinflip');
const statsRouter = require('./routes/stats');

app.use('/', slotsRouter);
app.use('/admin', adminRouter);
app.use('/coinflip', coinflipRouter);
app.use('/stats', statsRouter);

// Root & Health
app.get('/', (req, res) => res.json({ status: 'ok', service: 'SPIND BET API' }));
app.get('/health', (req, res) => res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    db: mongoose.connection.readyState === 1
}));

// Referral stats endpoint
app.get('/ref/stats/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) return res.status(400).json({ success: false, error: 'Invalid UID' });
        
        const [directRefs, level2Refs] = await Promise.all([
            User.find({ ref: uid }).select('uid balance createdAt').lean(),
            User.find({ ref2: uid }).select('uid balance createdAt').lean()
        ]);
        
        const directDeposits = directRefs.reduce((sum, u) => sum + (u.totalDeposited || 0), 0);
        const level2Deposits = level2Refs.reduce((sum, u) => sum + (u.totalDeposited || 0), 0);
        
        const user = await User.findOne({ uid });
        
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
        console.error('[SPIND BET] Ref stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to load referral stats' });
    }
});

// User endpoints
app.post('/user/register', async (req, res) => {
    try {
        const { uid, refCode } = req.body;
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        
        const user = await User.findOneAndUpdate(
            { uid }, 
            {}, 
            { upset: true, new: true, runValidators: true }
        );
        
        if (refCode && !user.ref && refCode !== uid) {
            const refUser = await User.findOne({ uid: refCode });
            if (refUser) {
                user.ref = refCode;
                if (refUser.ref && refUser.ref !== uid) {
                    user.ref2 = refUser.ref;
                }
                await user.save();
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('[SPIND BET] Registration error:', error);
        res.status(500).json({ success: false, error: 'Registration failed' });
    }
});

app.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        
        const user = await User.findOneAndUpdate(
            { uid }, 
            {}, 
            { upsert: true, new: true, runValidators: true }
        );
        
        const refCount = await User.countDocuments({ ref: uid });
        
        res.json({
            success: true,
            balance: Number(user.balance) || 0,
            refCode: user.uid,
            refCount,
            refEarn: Number(user.refEarn) || 0,
            lastBonus: user.lastBonus || 0,
            totalDeposited: Number(user.totalDeposited) || 0,
            lastCheckUrl: user.lastCheckUrl || '',
            totalGames: user.totalGames || 0,
            totalWins: user.totalWins || 0,
            totalWagered: user.totalWagered || 0
        });
        
    } catch (error) {
        console.error('[SPIND BET] Get user error:', error);
        res.status(500).json({ success: false, error: 'Failed to load user data', balance: 0 });
    }
});

// Deposit endpoints
app.post('/deposit', async (req, res) => {
    try {
        const { uid, amount, refCode } = req.body;
        
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!amount || amount < 0.01) {
            return res.status(400).json({ success: false, error: 'Minimum deposit is 0.01 USDT' });
        }
        
        if (!CRYPTO_TOKEN) {
            return res.status(503).json({ success: false, error: 'Payment service unavailable' });
        }
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createInvoice',
            {
                asset: 'USDT',
                amount: String(amount),
                description: `SPIND BET Deposit: ${amount} USDT`,
                payload: JSON.stringify({ uid, refCode }),
                expires_in: 3600
            },
            { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } }
        );
        
        if (!data.ok) {
            throw new Error(data.error?.description || 'Invoice creation failed');
        }
        
        await Invoice.create({
            iid: data.result.invoice_id,
            uid,
            amount,
            type: 'deposit',
            refCode,
            status: 'pending',
            expiresAt: new Date(Date.now() + 3600000)
        });
        
        res.json({
            success: true,
            invoiceUrl: data.result.pay_url,
            invoiceId: data.result.invoice_id,
            amount
        });
        
    } catch (error) {
        console.error('[SPIND BET] Deposit error:', error);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || 'Failed to create invoice'
        });
    }
});

app.post('/check-deposit', async (req, res) => {
    try {
        const { invoiceId } = req.body;
        if (!invoiceId) {
            return res.status(400).json({ success: false, error: 'Invoice ID required' });
        }
        
        const invoice = await Invoice.findOne({ iid: invoiceId });
        if (!invoice) {
            return res.status(404).json({ success: false, error: 'Invoice not found' });
        }
        
        if (invoice.status === 'paid') {
            return res.json({ 
                success: true,
                status: 'paid', 
                amount: invoice.amount,
                message: 'Already credited'
            });
        }
        
        const { data } = await axios.get(
            'https://pay.crypt.bot/api/getInvoices',
            {
                params: { invoice_ids: invoiceId },
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        const invoiceData = data.result.items[0];
        if (!invoiceData) {
            return res.status(404).json({ success: false, error: 'Invoice not found' });
        }
        
        if (invoiceData.status === 'paid') {
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    const user = await User.findOneAndUpdate(
                        { uid: invoice.uid },
                        { $inc: { balance: invoice.amount, totalDeposited: invoice.amount } },
                        { session }
                    );
                    
                    if (invoice.refCode && invoice.refCode !== invoice.uid) {
                        const ref = await User.findOne({ uid: invoice.refCode }).session(session);
                        if (ref) {
                            ref.balance += invoice.amount * 0.05;
                            ref.refEarn += invoice.amount * 0.05;
                            await ref.save({ session });
                            
                            if (ref.ref && ref.ref !== invoice.uid) {
                                const ref2 = await User.findOne({ uid: ref.ref }).session(session);
                                if (ref2) {
                                    ref2.balance += invoice.amount * 0.02;
                                    ref2.refEarn += invoice.amount * 0.02;
                                    await ref2.save({ session });
                                }
                            }
                        }
                    }
                    
                    invoice.status = 'paid';
                    invoice.paidAt = new Date();
                    await invoice.save({ session });
                });
                
                await session.endSession();
                
                res.json({
                    success: true,
                    status: 'paid',
                    amount: invoice.amount,
                    newBalance: user.balance,
                    message: 'Payment credited'
                });
                
            } catch (error) {
                await session.endSession();
                throw error;
            }
        } else {
            invoice.status = invoiceData.status;
            await invoice.save();
            
            res.json({ 
                success: true,
                status: invoiceData.status,
                message: `Invoice ${invoiceData.status}`
            });
        }
        
    } catch (error) {
        console.error('[SPIND BET] Check deposit error:', error);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || 'Failed to check invoice'
        });
    }
});

// Withdraw endpoint
app.post('/withdraw', async (req, res) => {
    try {
        const { uid, amount } = req.body;
        
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!amount || amount < 0.2) {
            return res.status(400).json({ success: false, error: 'Minimum withdrawal is 0.20 USDT' });
        }
        
        const user = await User.findOne({ uid });
        if (!user || user.balance < amount) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }
        
        if (!CRYPTO_TOKEN) {
            return res.status(503).json({ success: false, error: 'Payment service unavailable' });
        }
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createCheck',
            {
                asset: 'USDT',
                amount: String(amount.toFixed(2)),
                pin_to_user_id: uid,
                description: `SPIND BET Withdrawal for user ${uid}`
            },
            { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } }
        );
        
        if (!data.ok) {
            throw new Error(data.error?.description || 'Check creation failed');
        }
        
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                user.balance -= amount;
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
                    {
                        chat_id: ADMIN_ID,
                        text: `📤 Withdrawal: User ${uid} - ${amount} USDT`
                    }
                ).catch(() => {});
            }
            
            res.json({
                success: true,
                amount,
                newBalance: user.balance,
                checkUrl: data.result.bot_check_url
            });
            
        } catch (error) {
            await session.endSession();
            throw error;
        }
        
    } catch (error) {
        console.error('[SPIND BET] Withdraw error:', error);
        res.status(500).json({ 
            success: false,
            error: error.response?.data?.error?.description || 'Withdrawal failed'
        });
    }
});

// Error handling
app.use((error, req, res, next) => {
    console.error('[SPIND BET] Unhandled error:', error);
    res.status(500).json({ 
        success: false,
        error: 'Internal server error'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SPIND BET] Server running on port ${PORT}`);
});
