const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const Bottleneck = require('bottleneck');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Track bandwidth usage
let bandwidthUsed = 0;
const BANDWIDTH_LIMIT = 95 * 1024 * 1024 * 1024; // 95 GB (leave buffer)

// Trust the first proxy
app.set('trust proxy', 1); // Trust first proxy

// ============================================
// 1. CACHING LAYER
// ============================================
const imgCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// ============================================
// 2. RATE LIMITING - Source Website
// ============================================
const limiter = new Bottleneck({
  minTime: 200,
  maxConcurrent: 5
});

// ============================================
// 3. RATE LIMITING - Per User/IP
// ============================================
const userLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per 15 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

// ============================================
// 4. API KEY AUTHENTICATION (Optional but Recommended)
// ============================================
const apiKeyMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.API_KEY;

  // If API_KEY is not set in env, skip authentication
  if (!validApiKey) {
    return next();
  }

  if (!apiKey || apiKey !== validApiKey) {
    console.log(`Received invalid API key: ${apiKey}`);
    console.log(`Expected API key: ${validApiKey}`);
    
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }

  next();
};

// ============================================
// 5. BANDWIDTH MONITORING
// ============================================
const bandwidthMiddleware = (req, res, next) => {
  if (bandwidthUsed >= BANDWIDTH_LIMIT) {
    return res.status(503).json({ 
      error: 'Service temporarily unavailable: Monthly bandwidth limit reached',
      resetDate: getNextMonthDate()
    });
  }
  next();
};

function getNextMonthDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

// Track response size
app.use((req, res, next) => {
  const originalSend = res.send;
  res.send = function(data) {
    if (Buffer.isBuffer(data)) {
      bandwidthUsed += data.length;
    }
    return originalSend.call(this, data);
  };
  next();
});

// ============================================
// 6. CORS Configuration
// ============================================
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    const allowedPatterns = [
      // Main site
      /^https:\/\/op-reader-scraper\.netlify\.app$/,
      
      // Branch deploys
      /^https:\/\/[a-zA-Z0-9-]+--op-reader-scraper\.netlify\.app$/,
      
      // Localhost
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/
    ];
    
    const isAllowed = allowedPatterns.some(pattern => pattern.test(origin));
    
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'OPTIONS']
};

app.use(cors(corsOptions));

// ============================================
// 7. CHECK CHAPTER/PAGE EXISTENCE (Lightweight)
// ============================================
app.head('/api/proxy/:chapter/:page',
  userLimiter,
  bandwidthMiddleware,
  async (req, res) => {
    const { chapter, page } = req.params;

    // Validate inputs
    if (!/^\d+$/.test(chapter) || !/^\d+$/.test(page)) {
      return res.status(400).end();
    }

    // Validate chapter range
    const chapterNum = parseInt(chapter);
    if (chapterNum < 1047 || chapterNum > 1166) {
      return res.status(400).end();
    }

    const formattedPage = page.toString().padStart(2, '0');
    const cacheKey = `ch_${chapter}_pg_${formattedPage}`;

    // A. Check Cache First
    const cachedData = imgCache.get(cacheKey);
    if (cachedData) {
      if (cachedData === '404') {
        return res.status(404).end();
      }
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).end();
    }

    // B. Make HEAD request to source (doesn't download body)
    const sourceUrl = `https://mangamoins.com/files/scans/OP${chapter}/${formattedPage}.png`;

    try {
      await limiter.schedule(() => axios.head(sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OPScraperBot/1.0)'
        },
        timeout: 5000
      }));

      res.setHeader('X-Cache', 'MISS');
      return res.status(200).end();

    } catch (error) {
      if (error.response && error.response.status === 404) {
        // Cache negative result
        imgCache.set(cacheKey, '404', 3600);
        return res.status(404).end();
      }
      
      console.error(`Error checking ${sourceUrl}:`, error.message);
      return res.status(500).end();
    }
});

// ============================================
// 8. MAIN PROXY ENDPOINT
// ============================================
app.get('/api/proxy/:chapter/:page', 
  bandwidthMiddleware,   // Check bandwidth
  async (req, res) => {
    const { chapter, page } = req.params;

    // Validate inputs
    if (!/^\d+$/.test(chapter) || !/^\d+$/.test(page)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }

    // Validate chapter range (1047-tbd)
    const chapterNum = parseInt(chapter);
    if (chapterNum < 1047) {
      return res.status(400).json({ 
        error: 'Chapter out of range',
        validRange: '1047 and above'
      });
    }

    const formattedPage = page.toString().padStart(2, '0');
    const cacheKey = `ch_${chapter}_pg_${formattedPage}`;

    // A. Check Cache (Fast Path)
    const cachedData = imgCache.get(cacheKey);
    if (cachedData) {
      console.log(`Cache hit for chapter ${chapter}, page ${formattedPage}`);
      if (cachedData === '404') {
        return res.status(404).json({ error: 'Not Found' });
      }
      
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Bandwidth-Used', formatBytes(bandwidthUsed));
      return res.send(cachedData);
    }

    // B. Fetch from Source (Slow Path - Rate Limited)
    const sourceUrl = `https://mangamoins.com/files/scans/OP${chapter}/${formattedPage}.png`;

    try {
      console.log(`Proxying request to: ${sourceUrl}`);
      const response = await limiter.schedule(() => axios.get(sourceUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OPScraperBot/1.0)'
        },
        timeout: 10000 // 10 second timeout
      }));

      const imgBuffer = Buffer.from(response.data, 'binary');

      // Store in cache
      imgCache.set(cacheKey, imgBuffer);

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Bandwidth-Used', formatBytes(bandwidthUsed));
      res.send(imgBuffer);

    } catch (error) {
      if (error.response && error.response.status === 404) {
        imgCache.set(cacheKey, '404', 3600);
        return res.status(404).json({ error: 'Not Found' });
      }
      
      console.error(`Error proxying ${sourceUrl}:`, error.message);
      res.status(500).json({ error: 'Proxy Error' });
    }
});

// ============================================
// 9. MONITORING ENDPOINTS
// ============================================
app.get('/api/stats', (req, res) => {
  const stats = imgCache.getStats();
  res.json({
    cacheHits: stats.hits,
    cacheMisses: stats.misses,
    cacheKeys: stats.keys,
    bandwidthUsed: formatBytes(bandwidthUsed),
    bandwidthLimit: formatBytes(BANDWIDTH_LIMIT),
    bandwidthRemaining: formatBytes(BANDWIDTH_LIMIT - bandwidthUsed),
    percentageUsed: ((bandwidthUsed / BANDWIDTH_LIMIT) * 100).toFixed(2) + '%'
  });
});

app.get('/', (req, res) => {
    res.send('OP Scraper Proxy is Active');
});

// ============================================
// 10. ADMIN ENDPOINT (Protected)
// ============================================
app.post('/api/admin/reset-bandwidth', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  bandwidthUsed = 0;
  res.json({ message: 'Bandwidth counter reset', bandwidthUsed: 0 });
});

// Helper function
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
