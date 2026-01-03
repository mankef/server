require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();

// ===== БЕЗОПАСНЫЙ CORS ДЛЯ ВСЕХ ЗАПРОСОВ =====
const ALLOWED_ORIGINS = [
    'https://miniapp-sigma-roan.vercel.app',
    'http://localhost:3000',
    'https://localhost:3000'
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // Разрешаем конкретный origin
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    
    // ВАЖНО: Разрешаем credentials и нужные заголовки
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bot-Token');
    
    // Обрабатываем preflight OPTIONS запрос
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    next();
});

app.use(express.json({ limit: '10mb' }));

// ===== МОДЕЛИ И КОНФИГ =====
const { User, Invoice } = require('./models');

const CRYPTO_TOKEN = process.env.CRYPTO_TOKEN;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');

console.log('[✓] Server starting...');
console.log('[i] CRYPTO_TOKEN:', CRYPTO_TOKEN ? 'SET' : 'MISSING');
console.log('[i] ALLOWED_ORIGINS:', ALLOWED_ORIGINS);

// ===== ГЛАВНЫЕ ЭНДПОИНТЫ =====

// Health check (для Railway)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', cors: 'enabled', timestamp: Date.now() });
});

// User data
app.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) throw new Error('Invalid UID');
        
        const user = await User.findOneAndUpdate(
            { uid }, 
            {}, 
            { upsert: true, new: true, runValidators: true }
        );
        
        // ВАЖНО: Отправляем заголовки CORS
        res.json({
            success: true,
            balance: Number(user.balance) || 0,
            refCode: user.uid,
            refEarn: Number(user.refEarn) || 0,
            lastBonus: user.lastBonus || 0,
            totalDeposited: Number(user.totalDeposited) || 0,
            message: 'User data loaded'
        });
        
    } catch (error) {
        console.error('[USER ERROR]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create deposit
app.post('/deposit', async (req, res) => {
    try {
        const { uid, amount } = req.body;
        
        console.log(`[DEPOSIT] UID: ${uid}, Amount: ${amount}`);
        
        if (!CRYPTO_TOKEN) throw new Error('CRYPTO_TOKEN not set');
        
        const { data } = await axios.post(
            'https://pay.crypt.bot/api/createInvoice',
            {
                asset: 'USDT',
                amount: String(amount),
                description: `SPIND BET Deposit: ${amount} USDT`,
                expires_in: 3600
            },
            { headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } }
        );
        
        if (!data.ok) throw new Error(data.error?.description);
        
        await Invoice.create({
            iid: data.result.invoice_id,
            uid,
            amount,
            type: 'deposit',
            status: 'pending',
            expiresAt: new Date(Date.now() + 3600000)
        });
        
        res.json({
            success: true,
            invoiceUrl: data.result.pay_url,
            invoiceId: data.result.invoice_id
        });
        
    } catch (error) {
        console.error('[DEPOSIT ERROR]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check deposit
app.post('/check-deposit', async (req, res) => {
    try {
        const { invoiceId } = req.body;
        
        const invoice = await Invoice.findOne({ iid: invoiceId });
        if (!invoice) throw new Error('Invoice not found');
        
        const { data } = await axios.get(
            'https://pay.crypt.bot/api/getInvoices',
            { params: { invoice_ids: invoiceId }, headers: { 'Crypto-Pay-API-Token': CRYPTO_TOKEN } }
        );
        
        const invoiceData = data.result.items[0];
        
        if (invoiceData.status === 'paid' && invoice.status !== 'paid') {
            const user = await User.findOneAndUpdate(
                { uid: invoice.uid },
                { $inc: { balance: invoice.amount, totalDeposited: invoice.amount } },
                { new: true }
            );
            
            invoice.status = 'paid';
            invoice.paidAt = new Date();
            await invoice.save();
            
            res.json({ success: true, status: 'paid', amount: invoice.amount, newBalance: user.balance });
        } else {
            res.json({ success: true, status: invoiceData.status });
        }
        
    } catch (error) {
        console.error('[CHECK ERROR]', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[✓] Server running on port ${PORT}`);
});

module.exports = app;
