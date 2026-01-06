// server.js
const express = require('express');
const cors = require('cors');

const app = express();

// ПЕРВАЯ middleware - CORS
app.use(cors({
    origin: '*', // Временно для теста
    credentials: true
}));

// ВТОРАЯ middleware - JSON parser
app.use(express.json());

// ТРЕТЬЯ - тестовый маршрут (обязательно до app.listen!)
app.get('/health', (req, res) => {
    res.json({ status: 'alive', port: process.env.PORT || 8080 });
});

app.get('/api/test', (req, res) => {
    res.json({ success: true, message: 'API works!' });
});

// ЧЕТВЕРТОЙ - запуск сервера
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on ${PORT}`);
    console.log('🔗 Health: https://your-url.onrender.com/health');
});
