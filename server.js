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
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per windowMs
    message: 'Too many requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Admin rate limiting
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many admin requests.',
});
app.use('/admin', adminLimiter);

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
})
.then(() => console.log('[SPIND BET] MongoDB connected successfully'))
.catch(err => {
    console.error('[SPIND BET] MongoDB connection error:', err);
    process.exit(1);
});

// Models
const { User, Invoice, Settings } = require('./models');
const fair = require('./utils/fair');

// API Config
const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const SERVER_URL = process.env.SERVER_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');

if (!CRYPTO_TOKEN) console.warn('[SPIND BET] CRYPTO_TOKEN not set - payments disabled');
if (!BOT_TOKEN) console.warn('[SPIND BET] BOT_TOKEN not set - admin features limited');

// Routes
const slotsRouter = require('./routes/slots');
const adminRouter = require('./routes/admin');

app.use('/', slotsRouter);
app.use('/admin', adminRouter);

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Register user
app.post('/user/register', async (req, res) => {
    try {
        const { uid, refCode } = req.body;
        
        // Validation
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        
        // Create or get user
        const user = await User.findOneAndUpdate(
            { uid }, 
            {}, 
            { upsert: true, new: true, runValidators: true }
        );
        
        // Handle referral
        if (refCode && !user.ref && refCode !== uid) {
            const refUser = await User.findOne({ uid: refCode });
            if (refUser) {
                user.ref = refCode;
                // Second level referral
                if (refUser.ref && refUser.ref !== uid) {
                    user.ref2 = refUser.ref;
                }
                await user.save();
                console.log(`[SPIND BET] User ${uid} registered with ref ${refCode}`);
            }
        }
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[SPIND BET] Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Create deposit invoice
app.post('/deposit', async (req, res) => {
    try {
        const { uid, amount, refCode } = req.body;
        
        // Validation
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        if (!amount || amount < 0.01) {
            return res.status(400).json({ error: 'Minimum deposit is 0.01 USDT' });
        }
        if (amount > 10000) {
            return res.status(400).json({ error: 'Maximum deposit is 10000 USDT' });
        }
        
        if (!CRYPTO_TOKEN) {
            return res.status(503).json({ error: 'Payment service unavailable' });
        }
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createInvoice',
            {
                asset: 'USDT',
                amount: String(amount),
                description: `SPIND BET Deposit: ${amount} USDT`,
                payload: JSON.stringify({ uid, refCode }),
                expires_in: 3600 // 1 hour
            },
            {
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
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
        console.error('[SPIND BET] Deposit error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.response?.data?.error?.description || 'Failed to create invoice' 
        });
    }
});

// Check deposit status
app.post('/check-deposit', async (req, res) => {
    try {
        const { invoiceId } = req.body;
        
        if (!invoiceId) {
            return res.status(400).json({ error: 'Invoice ID required' });
        }
        
        const invoice = await Invoice.findOne({ iid: invoiceId });
        if (!invoice) {
            return res.status(404).json({ error: 'Invoice not found' });
        }
        
        if (invoice.status === 'paid') {
            return res.json({ 
                status: 'paid', 
                amount: invoice.amount, 
                alreadyProcessed: true,
                message: 'Already credited'
            });
        }
        
        if (invoice.status === 'expired') {
            return res.json({ status: 'expired' });
        }
        
        // Check with Crypto Pay
        const { data } = await axios.get(
            'https://pay.crypt.bot/api/getInvoices',
            {
                params: { invoice_ids: invoiceId },
                headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN }
            }
        );
        
        const invoiceData = data.result.items[0];
        if (!invoiceData) {
            return res.status(404).json({ error: 'Invoice not found in payment system' });
        }
        
        if (invoiceData.status === 'paid') {
            // Process payment in transaction
            const session = await mongoose.startSession();
            try {
                await session.withTransaction(async () => {
                    // Update user balance
                    const user = await User.findOneAndUpdate(
                        { uid: invoice.uid },
                        { 
                            $inc: { 
                                balance: invoice.amount,
                                totalDeposited: invoice.amount 
                            }
                        },
                        { upsert: true, new: true, session }
                    );
                    
                    // Process referrals
                    if (invoice.refCode && invoice.refCode !== invoice.uid) {
                        const ref1 = await User.findOne({ uid: invoice.refCode }).session(session);
                        if (ref1) {
                            const ref1Bonus = invoice.amount * 0.05;
                            ref1.balance += ref1Bonus;
                            ref1.refEarn += ref1Bonus;
                            await ref1.save({ session });
                            
                            // Second level
                            if (ref1.ref && ref1.ref !== invoice.uid) {
                                const ref2 = await User.findOne({ uid: ref1.ref }).session(session);
                                if (ref2) {
                                    const ref2Bonus = invoice.amount * 0.02;
                                    ref2.balance += ref2Bonus;
                                    ref2.refEarn += ref2Bonus;
                                    await ref2.save({ session });
                                }
                            }
                        }
                    }
                    
                    // Mark invoice as paid
                    invoice.status = 'paid';
                    invoice.paidAt = new Date();
                    await invoice.save({ session });
                    
                    console.log(`[SPIND BET] Deposit processed: ${invoice.uid} - ${invoice.amount} USDT`);
                });
                
                await session.endSession();
                
                res.json({
                    success: true,
                    status: 'paid',
                    amount: invoice.amount,
                    message: 'Payment credited successfully'
                });
                
            } catch (error) {
                await session.endSession();
                throw error;
            }
            
        } else {
            // Update status if changed
            if (invoiceData.status !== invoice.status) {
                invoice.status = invoiceData.status;
                await invoice.save();
            }
            
            res.json({ 
                success: true,
                status: invoiceData.status,
                message: `Invoice ${invoiceData.status}`
            });
        }
        
    } catch (error) {
        console.error('[SPIND BET] Check deposit error:', error);
        res.status(500).json({ 
            error: error.response?.data?.error?.description || 'Failed to check invoice' 
        });
    }
});

// Withdraw via check
app.post('/withdraw', async (req, res) => {
    try {
        const { uid, amount } = req.body;
        
        // Validation
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        if (!amount || amount < 0.2) {
            return res.status(400).json({ error: 'Minimum withdrawal is 0.20 USDT' });
        }
        if (amount > 1000) {
            return res.status(400).json({ error: 'Maximum withdrawal is 1000 USDT' });
        }
        
        const user = await User.findOne({ uid });
        if (!user || user.balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        if (!CRYPTO_TOKEN) {
            return res.status(503).json({ error: 'Payment service unavailable' });
        }
        
        const spendId = `spindbet_withdraw_${uid}_${Date.now()}`;
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
            throw new Error(data.error?.description || 'Check creation failed');
        }
        
        // Process withdrawal in transaction
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
            
            // Notify admin
            if (ADMIN_ID) {
                try {
                    await axios.post(
                        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
                        {
                            chat_id: ADMIN_ID,
                            text: `
📤 *SPIND BET Withdrawal*

👤 User: ${uid}
💰 Amount: ${amount} USDT
🔗 Check: ${data.result.bot_check_url}
                            `,
                            parse_mode: 'Markdown'
                        }
                    );
                } catch (e) {
                    console.log('[SPIND BET] Admin notify failed');
                }
            }
            
            res.json({
                success: true,
                amount,
                newBalance: user.balance,
                checkUrl: data.result.bot_check_url,
                message: 'Withdrawal successful!'
            });
            
        } catch (error) {
            await session.endSession();
            throw error;
        }
        
    } catch (error) {
        console.error('[SPIND BET] Withdraw error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: error.response?.data?.error?.description || 'Withdrawal failed' 
        });
    }
});

// Get user data
app.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        
        const user = await User.findOneAndUpdate(
            { uid },
            {}, 
            { upsert: true, new: true, runValidators: true }
        );
        
        const refCount = await User.countDocuments({ ref: uid });
        
        res.json({
            success: true,
            balance: user.balance,
            refCode: user.uid,
            refCount,
            refEarn: user.refEarn,
            lastBonus: user.lastBonus,
            totalDeposited: user.totalDeposited,
            lastCheckUrl: user.lastCheckUrl,
            lastWithdrawalAt: user.lastWithdrawalAt
        });
        
    } catch (error) {
        console.error('[SPIND BET] Get user error:', error);
        res.status(500).json({ error: 'Failed to load user data' });
    }
});

// Update bonus timestamp
app.post('/bonus', async (req, res) => {
    try {
        const { uid, now } = req.body;
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ error: 'Invalid user ID' });
        }
        
        await User.updateOne(
            { uid },
            { $set: { lastBonus: now } },
            { runValidators: true }
        );
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[SPIND BET] Bonus update error:', error);
        res.status(500).json({ error: 'Failed to update bonus' });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('[SPIND BET] Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        requestId: req.id 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SPIND BET] Server running on port ${PORT} 🌸`);
});

module.exports = app;
