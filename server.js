const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors({
    origin: ['https://server-production-b3d5.up.railway.app'], // ЗАМЕНИТЕ на ваш домен
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// MongoDB schemas
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    balance: { type: Number, default: 0 },
    totalDeposited: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
    lastActivity: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

const invoiceSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    invoiceId: { type: String, required: true, unique: true, index: true },
    address: String,
    network: { type: String, default: 'TRC20' },
    status: { type: String, enum: ['pending', 'paid', 'expired'], default: 'pending' },
    paidAt: Date,
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 60 * 1000) }
});

const withdrawSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    fee: { type: Number, default: 0.05 },
    totalAmount: { type: Number, required: true },
    checkCode: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

const gameHistorySchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    type: { type: String, enum: ['spin', 'deposit', 'withdraw'], required: true },
    bet: Number,
    win: Number,
    balanceBefore: Number,
    balanceAfter: Number,
    result: [String],
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const Withdraw = mongoose.model('Withdraw', withdrawSchema);
const GameHistory = mongoose.model('GameHistory', gameHistorySchema);

// Валидация Telegram WebApp
function validateTelegramData(initData) {
    // Реальная валидация должна быть реализована здесь
    // https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
    return true; // В продакшене заменить на реальную проверку
}

// Middleware
const authMiddleware = (req, res, next) => {
    const userId = req.headers['x-user-id'];
    const userHash = req.headers['x-user-hash'];
    
    if (!userId || !userHash) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    if (!validateTelegramData(userHash)) {
        return res.status(401).json({ success: false, error: 'Invalid hash' });
    }
    
    req.userId = userId;
    next();
};

// CryptoBot API
const CRYPTO_BOT_API_KEY = process.env.CRYPTO_BOT_API_KEY;
const CRYPTO_BOT_URL = 'https://pay.crypt.bot/api';

class CryptoBotAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.headers = {
            'Crypto-Pay-API-Token': apiKey,
            'Content-Type': 'application/json'
        };
    }

    async createInvoice(amount, asset = 'USDT') {
        try {
            const response = await axios.post(`${CRYPTO_BOT_URL}/createInvoice`, {
                asset,
                amount: amount.toString(),
                description: `Пополнение на ${amount} USDT`,
                hidden_message: `+${amount} USDT зачислено`,
                paid_btn_name: 'callback',
                paid_btn_url: 'https://t.me/' + process.env.BOT_USERNAME,
                payload: JSON.stringify({ type: 'deposit', userId: req.userId })
            }, { headers: this.headers });

            return {
                success: true,
                invoiceId: response.data.result.invoice_id,
                address: response.data.result.address,
                network: response.data.result.network,
                amount: parseFloat(response.data.result.amount)
            };
        } catch (error) {
            console.error('CryptoBot createInvoice error:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || error.message };
        }
    }

    async getInvoice(invoiceId) {
        try {
            const response = await axios.get(`${CRYPTO_BOT_URL}/getInvoices`, {
                headers: this.headers,
                params: { invoice_ids: invoiceId }
            });

            if (response.data.result?.items?.length > 0) {
                const invoice = response.data.result.items[0];
                return {
                    success: true,
                    status: invoice.status,
                    paidAmount: invoice.paid_amount ? parseFloat(invoice.paid_amount) : null,
                    paidAt: invoice.paid_at ? new Date(invoice.paid_at * 1000) : null
                };
            }
            return { success: false, error: 'Invoice not found' };
        } catch (error) {
            console.error('CryptoBot getInvoice error:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || error.message };
        }
    }

    async createCheck(asset, amount) {
        try {
            const response = await axios.post(`${CRYPTO_BOT_URL}/createCheck`, {
                asset,
                amount: amount.toString(),
                description: `Вывод ${amount} USDT`
            }, { headers: this.headers });

            return {
                success: true,
                checkCode: response.data.result.hash,
                checkId: response.data.result.check_id,
                botCheckUrl: response.data.result.bot_check_url
            };
        } catch (error) {
            console.error('CryptoBot createCheck error:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || error.message };
        }
    }
}

const cryptoBot = CRYPTO_BOT_API_KEY ? new CryptoBotAPI() : null;

// Вспомогательные функции
async function getOrCreateUser(userId, userData = {}) {
    const user = await User.findOneAndUpdate(
        { telegramId: userId },
        {
            $set: {
                username: userData.username,
                firstName: userData.first_name,
                lastName: userData.last_name,
                lastActivity: new Date()
            },
            $setOnInsert: {
                telegramId: userId,
                balance: 0
            }
        },
        { upsert: true, new: true }
    );
    return user;
}

// API endpoints

app.get('/api/balance', authMiddleware, async (req, res) => {
    try {
        const user = await getOrCreateUser(req.userId);
        res.json({ success: true, balance: user.balance });
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.post('/api/spin', authMiddleware, async (req, res) => {
    try {
        const { bet } = req.body;
        
        if (!bet || bet < 0.1 || bet > 10) {
            return res.status(400).json({ success: false, error: 'Ставка должна быть от 0.1 до 10 USDT' });
        }
        
        const user = await getOrCreateUser(req.userId);
        
        if (user.balance < bet) {
            return res.status(400).json({ success: false, error: 'Недостаточно средств' });
        }
        
        // Символы для слотов
        const symbols = [
            { emoji: '🍒', weight: 30, multiplier: 2 },
            { emoji: '🍋', weight: 25, multiplier: 3 },
            { emoji: '🍊', weight: 20, multiplier: 4 },
            { emoji: '🍇', weight: 15, multiplier: 5 },
            { emoji: '🔔', weight: 6, multiplier: 10 },
            { emoji: '⭐', weight: 3, multiplier: 20 },
            { emoji: '7️⃣', weight: 1, multiplier: 100 }
        ];
        
        // Результаты
        const results = [];
        for (let i = 0; i < 3; i++) {
            const totalWeight = symbols.reduce((sum, s) => sum + s.weight, 0);
            let random = Math.random() * totalWeight;
            let selected = symbols[0];
            
            for (const symbol of symbols) {
                random -= symbol.weight;
                if (random <= 0) {
                    selected = symbol;
                    break;
                }
            }
            results.push(selected.emoji);
        }
        
        // Проверка выигрыша
        let win = 0;
        const balanceBefore = user.balance;
        
        if (results[0] === results[1] && results[1] === results[2]) {
            const symbol = symbols.find(s => s.emoji === results[0]);
            win = bet * symbol.multiplier;
        } else if (results[0] === results[1] || results[1] === results[2] || results[0] === results[2]) {
            win = bet * 2;
        }
        
        // Обновляем баланс
        user.balance = balanceBefore - bet + win;
        user.gamesPlayed += 1;
        if (win > 0) user.totalWins += win;
        await user.save();
        
        // Сохраняем в историю
        const history = new GameHistory({
            userId: req.userId,
            type: 'spin',
            bet,
            win,
            balanceBefore,
            balanceAfter: user.balance,
            result: results,
            createdAt: new Date()
        });
        await history.save();
        
        res.json({
            success: true,
            results,
            win,
            newBalance: user.balance,
            balanceBefore
        });
        
    } catch (error) {
        console.error('Spin error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.post('/api/create-invoice', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body;
        
        if (!amount || amount < 0.02 || amount > 1000) {
            return res.status(400).json({ success: false, error: 'Минимум 0.02 USDT, максимум 1000 USDT' });
        }
        
        if (!cryptoBot) {
            return res.status(500).json({ success: false, error: 'CryptoBot API не настроен' });
        }
        
        const result = await cryptoBot.createInvoice(amount);
        
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }
        
        const invoice = new Invoice({
            userId: req.userId,
            amount,
            invoiceId: result.invoiceId,
            address: result.address,
            network: result.network,
            status: 'pending',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000)
        });
        
        await invoice.save();
        
        res.json({
            success: true,
            invoiceId: result.invoiceId,
            url: `https://t.me/CryptoBot?start=pay_${result.invoiceId}`,
            address: result.address,
            network: result.network,
            amount: result.amount
        });
        
    } catch (error) {
        console.error('Create invoice error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.get('/api/check-invoice', authMiddleware, async (req, res) => {
    try {
        const { invoiceId } = req.query;
        
        if (!invoiceId) {
            return res.status(400).json({ success: false, error: 'Invoice ID is required' });
        }
        
        const invoice = await Invoice.findOne({ invoiceId, userId: req.userId });
        
        if (!invoice) {
            return res.status(404).json({ success: false, error: 'Invoice not found' });
        }
        
        const status = await cryptoBot.getInvoice(invoiceId);
        
        if (!status.success) {
            return res.status(500).json({ success: false, error: status.error });
        }
        
        if (status.status === 'paid' && invoice.status === 'pending') {
            invoice.status = 'paid';
            invoice.paidAt = status.paidAt || new Date();
            await invoice.save();
            
            const user = await User.findOne({ telegramId: req.userId });
            const balanceBefore = user.balance;
            user.balance += invoice.amount;
            user.totalDeposited += invoice.amount;
            await user.save();
            
            const history = new GameHistory({
                userId: req.userId,
                type: 'deposit',
                win: invoice.amount,
                balanceBefore,
                balanceAfter: user.balance,
                createdAt: new Date()
            });
            await history.save();
        }
        
        res.json({
            success: true,
            status: invoice.status,
            amount: invoice.amount,
            paidAt: invoice.paidAt
        });
        
    } catch (error) {
        console.error('Check invoice error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.post('/api/create-withdraw', authMiddleware, async (req, res) => {
    try {
        const { amount } = req.body;
        
        if (!amount || amount < 0.3) {
            return res.status(400).json({ success: false, error: 'Минимальная сумма вывода 0.3 USDT' });
        }
        
        if (!cryptoBot) {
            return res.status(500).json({ success: false, error: 'CryptoBot API не настроен' });
        }
        
        const user = await User.findOne({ telegramId: req.userId });
        
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        const totalAmount = amount + 0.05;
        
        if (user.balance < totalAmount) {
            return res.status(400).json({ success: false, error: 'Недостаточно средств' });
        }
        
        const result = await cryptoBot.createCheck('USDT', amount);
        
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error });
        }
        
        const withdraw = new Withdraw({
            userId: req.userId,
            amount,
            fee: 0.05,
            totalAmount,
            checkCode: result.checkCode,
            checkId: result.checkId,
            status: 'pending',
            createdAt: new Date()
        });
        
        await withdraw.save();
        
        const balanceBefore = user.balance;
        user.balance -= totalAmount;
        user.totalWithdrawn += amount;
        await user.save();
        
        const history = new GameHistory({
            userId: req.userId,
            type: 'withdraw',
            win: -totalAmount,
            balanceBefore,
            balanceAfter: user.balance,
            createdAt: new Date()
        });
        await history.save();
        
        res.json({
            success: true,
            checkCode: result.checkCode,
            checkUrl: result.botCheckUrl,
            amount,
            fee: 0.05
        });
        
    } catch (error) {
        console.error('Create withdraw error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

app.get('/api/history', authMiddleware, async (req, res) => {
    try {
        const { type = 'all', limit = 50 } = req.query;
        
        const query = { userId: req.userId };
        if (type !== 'all') {
            query.type = type;
        }
        
        const history = await GameHistory.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit));
        
        res.json({
            success: true,
            history: history.map(h => ({
                type: h.type,
                amount: h.win || h.bet || 0,
                balanceBefore: h.balanceBefore,
                balanceAfter: h.balanceAfter,
                result: h.result,
                createdAt: h.createdAt
            }))
        });
        
    } catch (error) {
        console.error('History error:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// Webhook для CryptoBot
app.post('/webhook/cryptobot', express.json(), async (req, res) => {
    try {
        const { update_type, payload } = req.body;
        
        if (update_type === 'invoice_paid') {
            const invoice = await Invoice.findOne({ invoiceId: payload.invoice_id.toString() });
            
            if (invoice && invoice.status === 'pending') {
                invoice.status = 'paid';
                invoice.paidAt = new Date();
                await invoice.save();
                
                const user = await User.findOne({ telegramId: invoice.userId });
                const balanceBefore = user.balance;
                user.balance += invoice.amount;
                user.totalDeposited += invoice.amount;
                await user.save();
                
                const history = new GameHistory({
                    userId: invoice.userId,
                    type: 'deposit',
                    win: invoice.amount,
                    balanceBefore,
                    balanceAfter: user.balance,
                    createdAt: new Date()
                });
                await history.save();
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ success: false, error: 'Webhook error' });
    }
});

// Очистка просроченных инвойсов каждые 5 минут
async function cleanupExpiredInvoices() {
    try {
        const expired = await Invoice.find({
            status: 'pending',
            expiresAt: { $lt: new Date() }
        });
        
        for (const invoice of expired) {
            invoice.status = 'expired';
            await invoice.save();
        }
        
        console.log(`Очищено ${expired.length} просроченных инвойсов`);
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;

const mongoUri = process.env.MONGODB_PRIVATE_URL || process.env.MONGODB_URI;



mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`💰 CryptoBot API: ${CRYPTO_BOT_API_KEY ? 'Active' : 'Not configured'}`);
    });
    
    // Запуск очистки каждые 5 минут
    setInterval(cleanupExpiredInvoices, 5 * 60 * 1000);
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
});


