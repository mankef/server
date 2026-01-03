const express = require('express');
const router = express.Router();
const { Settings, User } = require('../models');

// Middleware для проверки admin
const verifyAdmin = (req, res, next) => {
    const secret = req.headers['x-admin-secret'];
    if (!secret || secret !== process.env.BOT_TOKEN) {
        return res.status(403).json({ success: false, error: 'Access denied' });
    }
    next();
};

router.use(verifyAdmin);

// Установить house edge
router.post('/set-edge', async (req, res) => {
    try {
        const { edge } = req.body;
        
        if (typeof edge !== 'number' || isNaN(edge) || edge < 0 || edge > 0.3) {
            return res.status(400).json({ 
                success: false, 
                error: 'Edge must be a number between 0 and 0.3' 
            });
        }
        
        await Settings.updateOne(
            {}, 
            { houseEdge: edge }, 
            { upsert: true, runValidators: true }
        );
        
        res.json({ 
            success: true, 
            houseEdge: edge,
            message: `House edge set to ${(edge * 100).toFixed(1)}%`
        });
        
    } catch (error) {
        console.error('[SPIND BET] Set edge error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to update house edge' 
        });
    }
});

// Получить статистику
router.get('/stats', async (req, res) => {
    try {
        const [totalUsers, totalDepositedAgg, topReferrers] = await Promise.all([
            User.countDocuments(),
            User.aggregate([
                { $group: { _id: null, total: { $sum: '$totalDeposited' } } }
            ]),
            User.find()
                .sort({ refEarn: -1 })
                .limit(10)
                .select('uid refEarn')
                .lean()
        ]);
        
        const totalDeposited = totalDepositedAgg[0]?.total || 0;
        
        res.json({
            success: true,
            totalUsers,
            totalDeposited,
            topReferrers: topReferrers.map(u => ({
                uid: u.uid,
                refEarn: u.refEarn
            }))
        });
        
    } catch (error) {
        console.error('[SPIND BET] Stats error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load statistics' 
        });
    }
});

// Получить информацию о пользователе
router.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid user ID' 
            });
        }
        
        const user = await User.findOne({ uid });
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        const refCount = await User.countDocuments({ ref: uid });
        
        res.json({
            success: true,
            user: {
                uid: user.uid,
                balance: user.balance,
                refEarn: user.refEarn,
                ref: user.ref,
                ref2: user.ref2,
                totalDeposited: user.totalDeposited,
                totalWithdrawn: user.totalWithdrawn,
                lastCheckUrl: user.lastCheckUrl,
                lastBonus: user.lastBonus,
                createdAt: user.createdAt,
                refCount
            }
        });
        
    } catch (error) {
        console.error('[SPIND BET] Get user error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to load user' 
        });
    }
});

// Тумблер режима обслуживания
router.post('/maintenance', async (req, res) => {
    try {
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ 
                success: false, 
                error: 'enabled must be boolean' 
            });
        }
        
        await Settings.updateOne(
            {},
            { maintenanceMode: enabled },
            { upsert: true }
        );
        
        res.json({
            success: true,
            maintenanceMode: enabled,
            message: `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`
        });
        
    } catch (error) {
        console.error('[SPIND BET] Maintenance toggle error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to toggle maintenance mode' 
        });
    }
});

module.exports = router;
