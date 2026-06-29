const serverUrl = process.env.API_URL || `http://localhost:${process.env.PORT || 5001}`;

export const swaggerSpec = {
    openapi: "3.0.0",
    info: {
        title: "Zentrade API",
        version: "1.0.0",
        description:
            "REST API for Zentrade — a real-time paper trading simulator for Indian stock markets. " +
            "Users get ₹10 lakh virtual balance to practice intraday (5x leverage) and delivery trading on 200+ NSE stocks.",
    },
    servers: [{ url: serverUrl, description: "API Server" }],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "JWT",
                description: "JWT token returned from /api/auth/login or /api/auth/signup",
            },
        },
        schemas: {
            Error: {
                type: "object",
                properties: { error: { type: "string", example: "Something went wrong" } },
            },
            User: {
                type: "object",
                properties: {
                    id: { type: "integer", example: 1 },
                    email: { type: "string", format: "email", example: "ravi@example.com" },
                    name: { type: "string", example: "Ravi" },
                    balancePaise: { type: "integer", example: 100000000, description: "Balance in paise (₹1 = 100 paise)" },
                },
            },
            AuthResponse: {
                type: "object",
                properties: {
                    token: { type: "string", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." },
                    user: { $ref: "#/components/schemas/User" },
                },
            },
            StockPrice: {
                type: "object",
                properties: {
                    symbol: { type: "string", example: "RELIANCE" },
                    name: { type: "string", example: "Reliance Industries" },
                    price: { type: "number", example: 2450.75 },
                    change: { type: "number", example: 12.5 },
                    changePercent: { type: "number", example: 0.51 },
                    open: { type: "number", example: 2440.0 },
                    previousClose: { type: "number", example: 2438.25 },
                    dayHigh: { type: "number", example: 2460.0 },
                    dayLow: { type: "number", example: 2435.0 },
                    volume: { type: "integer", example: 1240000 },
                    marketState: { type: "string", example: "REGULAR" },
                    timestamp: { type: "integer", example: 1717000000 },
                },
            },
            StockDetails: {
                type: "object",
                properties: {
                    symbol: { type: "string", example: "RELIANCE" },
                    companyName: { type: "string", example: "Reliance Industries" },
                    price: { type: "number", example: 2450.75 },
                    change: { type: "number", example: 12.5 },
                    changePercent: { type: "number", example: 0.51 },
                    marketCap: { type: "number", example: 1650000000000 },
                    peRatio: { type: "number", example: 28.4 },
                    dividendYield: { type: "number", example: 0.4 },
                    fiftyTwoWeekHigh: { type: "number", example: 3024.9 },
                    fiftyTwoWeekLow: { type: "number", example: 2180.1 },
                    exchangeName: { type: "string", example: "NSE" },
                    currency: { type: "string", example: "INR" },
                },
            },
            Fundamentals: {
                type: "object",
                properties: {
                    symbol: { type: "string", example: "RELIANCE" },
                    companyName: { type: "string", example: "Reliance Industries" },
                    marketCap: { type: "number", example: 1650000000000 },
                    peRatio: { type: "number", example: 28.4 },
                    pbRatio: { type: "number", example: 2.1 },
                    eps: { type: "number", example: 86.3 },
                    dividendYield: { type: "number", example: 0.4 },
                    bookValue: { type: "number", example: 1166.7 },
                    fiftyTwoWeekHigh: { type: "number", example: 3024.9 },
                    fiftyTwoWeekLow: { type: "number", example: 2180.1 },
                    avgVolume: { type: "integer", example: 9800000 },
                },
            },
            Performance: {
                type: "object",
                properties: {
                    open: { type: "number", example: 2440.0 },
                    previousClose: { type: "number", example: 2438.25 },
                    dayHigh: { type: "number", example: 2460.0 },
                    dayLow: { type: "number", example: 2435.0 },
                    fiftyTwoWeekHigh: { type: "number", example: 3024.9 },
                    fiftyTwoWeekLow: { type: "number", example: 2180.1 },
                    volume: { type: "integer", example: 1240000 },
                },
            },
            ChartCandle: {
                type: "object",
                properties: {
                    time: { type: "integer", example: 1717000000, description: "Unix timestamp" },
                    open: { type: "number", example: 2440.0 },
                    high: { type: "number", example: 2460.0 },
                    low: { type: "number", example: 2435.0 },
                    close: { type: "number", example: 2450.75 },
                    volume: { type: "integer", example: 120000 },
                },
            },
            Holding: {
                type: "object",
                properties: {
                    symbol: { type: "string", example: "RELIANCE" },
                    quantity: { type: "integer", example: 10 },
                    avgPricePaise: { type: "integer", example: 244075 },
                    currentPricePaise: { type: "integer", example: 245000 },
                    investedPaise: { type: "integer", example: 2440750 },
                    currentValuePaise: { type: "integer", example: 2450000 },
                    pnlPaise: { type: "integer", example: 9250 },
                    orderMode: { type: "string", enum: ["INTRADAY", "DELIVERY"] },
                    marginUsedPaise: { type: "integer", example: 488150 },
                },
            },
            Portfolio: {
                type: "object",
                properties: {
                    balancePaise: { type: "integer", example: 97559250 },
                    intradayHoldings: { type: "array", items: { $ref: "#/components/schemas/Holding" } },
                    deliveryHoldings: { type: "array", items: { $ref: "#/components/schemas/Holding" } },
                    totalInvestedPaise: { type: "integer", example: 2440750 },
                    totalCurrentPaise: { type: "integer", example: 2450000 },
                    totalPnlPaise: { type: "integer", example: 9250 },
                },
            },
            Order: {
                type: "object",
                properties: {
                    id: { type: "integer", example: 42 },
                    symbol: { type: "string", example: "RELIANCE" },
                    type: { type: "string", enum: ["BUY", "SELL"] },
                    quantity: { type: "integer", example: 10 },
                    pricePaise: { type: "integer", example: 244075 },
                    totalValuePaise: { type: "integer", example: 2440750 },
                    orderMode: { type: "string", enum: ["INTRADAY", "DELIVERY"] },
                    createdAt: { type: "string", format: "date-time" },
                },
            },
            TradeResult: {
                type: "object",
                properties: {
                    message: { type: "string", example: "Buy order executed" },
                    order: { $ref: "#/components/schemas/Order" },
                    newBalancePaise: { type: "integer", example: 97559250 },
                },
            },
            WatchlistItem: {
                type: "object",
                properties: {
                    symbol: { type: "string", example: "RELIANCE" },
                    name: { type: "string", example: "Reliance Industries" },
                    price: { type: "number", example: 2450.75 },
                    change: { type: "number", example: 12.5 },
                    changePercent: { type: "number", example: 0.51 },
                    addedAt: { type: "string", format: "date-time" },
                },
            },
            IndexData: {
                type: "object",
                properties: {
                    symbol: { type: "string", example: "^NSEI" },
                    name: { type: "string", example: "NIFTY 50" },
                    price: { type: "number", example: 22450.3 },
                    change: { type: "number", example: 120.5 },
                    changePercent: { type: "number", example: 0.54 },
                    timestamp: { type: "integer", example: 1717000000 },
                },
            },
            MarketStatus: {
                type: "object",
                properties: {
                    marketOpen: { type: "boolean", example: true },
                    currentTime: { type: "string", example: "10:30" },
                    nextEvent: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["open", "close"], example: "close" },
                            time: { type: "string", example: "15:30" },
                        },
                    },
                    timezone: { type: "string", example: "IST" },
                    tradingHours: {
                        type: "object",
                        properties: {
                            open: { type: "string", example: "09:15" },
                            close: { type: "string", example: "15:30" },
                        },
                    },
                },
            },
        },
    },
    tags: [
        { name: "Auth", description: "Signup, login, and Google OAuth" },
        { name: "Stocks", description: "NSE stock prices, details, fundamentals, and performance" },
        { name: "Chart", description: "OHLCV candlestick data" },
        { name: "Trade", description: "Buy and sell orders (JWT required)" },
        { name: "Portfolio", description: "User holdings and P&L (JWT required)" },
        { name: "Orders", description: "Trade history (JWT required)" },
        { name: "Watchlist", description: "Saved stocks (JWT required)" },
        { name: "Indices", description: "NIFTY 50, SENSEX, BANK NIFTY" },
        { name: "Market", description: "Market open/close status" },
        { name: "AI", description: "AI-powered stock analysis (JWT required)" },
        { name: "Health", description: "Server health check" },
    ],
    paths: {
        // ─── Auth ────────────────────────────────────────────────────────────
        "/api/auth/signup": {
            post: {
                tags: ["Auth"],
                summary: "Register with email and password",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["email", "password"],
                                properties: {
                                    email: { type: "string", format: "email", example: "ravi@example.com" },
                                    password: { type: "string", minLength: 8, example: "secret123" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: { description: "Account created", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
                    400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    409: { description: "Email already registered", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/auth/login": {
            post: {
                tags: ["Auth"],
                summary: "Login with email and password",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["email", "password"],
                                properties: {
                                    email: { type: "string", format: "email", example: "ravi@example.com" },
                                    password: { type: "string", example: "secret123" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Login successful", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
                    401: { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/auth/google": {
            post: {
                tags: ["Auth"],
                summary: "Login or register with Google OAuth",
                description: "Pass the authorization code from Google's auth-code popup flow. The server exchanges it server-side using the client secret. Creates a new account if the email doesn't exist.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["code"],
                                properties: {
                                    code: { type: "string", example: "4/0AY0e-g7..." },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Auth successful", content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } } },
                    400: { description: "Missing or invalid code", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    401: { description: "Google code exchange failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Stocks ──────────────────────────────────────────────────────────
        "/api/stocks": {
            get: {
                tags: ["Stocks"],
                summary: "Get all 200+ NSE stocks with live prices",
                description: "Returns cached prices from Redis, refreshed in real time over WebSocket and backstopped every 5 minutes by the market worker.",
                responses: {
                    200: {
                        description: "List of stocks",
                        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/StockPrice" } } } },
                    },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/stocks/{symbol}": {
            get: {
                tags: ["Stocks"],
                summary: "Get live price for a single stock",
                parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } }],
                responses: {
                    200: { description: "Stock price data", content: { "application/json": { schema: { $ref: "#/components/schemas/StockPrice" } } } },
                    404: { description: "Stock not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/stocks/{symbol}/details": {
            get: {
                tags: ["Stocks"],
                summary: "Get stock details (P/E, market cap, 52-week range)",
                description: "Cached in Redis for 1 hour.",
                parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } }],
                responses: {
                    200: { description: "Stock details", content: { "application/json": { schema: { $ref: "#/components/schemas/StockDetails" } } } },
                    502: { description: "Yahoo Finance upstream error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/stocks/{symbol}/fundamentals": {
            get: {
                tags: ["Stocks"],
                summary: "Get fundamental metrics (EPS, book value, ratios)",
                description: "Cached in Redis for 1 hour.",
                parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } }],
                responses: {
                    200: { description: "Fundamentals", content: { "application/json": { schema: { $ref: "#/components/schemas/Fundamentals" } } } },
                    502: { description: "Yahoo Finance upstream error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/stocks/{symbol}/performance": {
            get: {
                tags: ["Stocks"],
                summary: "Get intraday performance stats (day high/low, 52-week range)",
                description: "Cached in Redis for 5 minutes.",
                parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } }],
                responses: {
                    200: { description: "Performance stats", content: { "application/json": { schema: { $ref: "#/components/schemas/Performance" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/stocks/{symbol}/full": {
            get: {
                tags: ["Stocks"],
                summary: "Get chart + performance + fundamentals in one request",
                description: "Used by the StockDetail page to avoid three separate calls. Chart, performance, and fundamentals are all bundled.",
                parameters: [
                    { name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } },
                    {
                        name: "range",
                        in: "query",
                        required: false,
                        schema: { type: "string", enum: ["1d", "5d", "1mo", "3mo", "1y", "5y"], default: "1d" },
                    },
                ],
                responses: {
                    200: {
                        description: "Full stock data",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        symbol: { type: "string" },
                                        companyName: { type: "string" },
                                        price: { type: "number" },
                                        change: { type: "number" },
                                        changePercent: { type: "number" },
                                        marketState: { type: "string" },
                                        performance: { $ref: "#/components/schemas/Performance" },
                                        fundamentals: { $ref: "#/components/schemas/Fundamentals" },
                                        chart: { type: "array", items: { $ref: "#/components/schemas/ChartCandle" } },
                                    },
                                },
                            },
                        },
                    },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Chart ───────────────────────────────────────────────────────────
        "/api/chart/{symbol}": {
            get: {
                tags: ["Chart"],
                summary: "Get OHLCV candlestick data",
                description: "Returns an array of candles for the given symbol and time range. Cached in Redis.",
                parameters: [
                    { name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } },
                    {
                        name: "range",
                        in: "query",
                        required: false,
                        schema: { type: "string", enum: ["1d", "5d", "1mo", "3mo", "1y", "5y"], default: "1d" },
                        description: "1d=1m interval, 5d=5m, 1mo=1h, 3mo/1y=1d, 5y=1wk",
                    },
                ],
                responses: {
                    200: {
                        description: "Array of OHLCV candles",
                        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ChartCandle" } } } },
                    },
                    400: { description: "Invalid range", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    502: { description: "Yahoo Finance upstream error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Trade ───────────────────────────────────────────────────────────
        "/api/trade/buy": {
            post: {
                tags: ["Trade"],
                summary: "Execute a buy order",
                description: "INTRADAY orders require market hours (09:15–15:30 IST) and use 5x leverage. DELIVERY orders work anytime.",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["symbol", "quantity"],
                                properties: {
                                    symbol: { type: "string", example: "RELIANCE" },
                                    quantity: { type: "integer", minimum: 1, example: 10 },
                                    mode: { type: "string", enum: ["INTRADAY", "DELIVERY"], default: "INTRADAY" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Order executed", content: { "application/json": { schema: { $ref: "#/components/schemas/TradeResult" } } } },
                    400: { description: "Market closed / invalid mode / insufficient balance", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/trade/sell": {
            post: {
                tags: ["Trade"],
                summary: "Execute a sell order",
                description: "INTRADAY sells require market hours. DELIVERY sells work anytime.",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["symbol", "quantity"],
                                properties: {
                                    symbol: { type: "string", example: "RELIANCE" },
                                    quantity: { type: "integer", minimum: 1, example: 10 },
                                    mode: { type: "string", enum: ["INTRADAY", "DELIVERY"], default: "INTRADAY" },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: "Order executed", content: { "application/json": { schema: { $ref: "#/components/schemas/TradeResult" } } } },
                    400: { description: "Market closed / invalid mode / insufficient holdings", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Portfolio ───────────────────────────────────────────────────────
        "/api/portfolio": {
            get: {
                tags: ["Portfolio"],
                summary: "Get user's portfolio with live P&L",
                description: "Returns holdings split into INTRADAY and DELIVERY, with live prices from Redis for real-time P&L.",
                security: [{ bearerAuth: [] }],
                responses: {
                    200: { description: "Portfolio data", content: { "application/json": { schema: { $ref: "#/components/schemas/Portfolio" } } } },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Orders ──────────────────────────────────────────────────────────
        "/api/orders": {
            get: {
                tags: ["Orders"],
                summary: "Get trade history (last 100 orders)",
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: "Order history",
                        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } },
                    },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Watchlist ───────────────────────────────────────────────────────
        "/api/watchlist": {
            get: {
                tags: ["Watchlist"],
                summary: "Get all watchlisted stocks with live prices",
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: "Watchlist",
                        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/WatchlistItem" } } } },
                    },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/watchlist/add": {
            post: {
                tags: ["Watchlist"],
                summary: "Add a stock to watchlist",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["symbol"],
                                properties: { symbol: { type: "string", example: "RELIANCE" } },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "Added",
                        content: { "application/json": { schema: { type: "object", properties: { symbol: { type: "string" }, added: { type: "boolean" } } } } },
                    },
                    400: { description: "Invalid symbol", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },
        "/api/watchlist/remove": {
            delete: {
                tags: ["Watchlist"],
                summary: "Remove a stock from watchlist",
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["symbol"],
                                properties: { symbol: { type: "string", example: "RELIANCE" } },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: "Removed",
                        content: { "application/json": { schema: { type: "object", properties: { symbol: { type: "string" }, removed: { type: "boolean" } } } } },
                    },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Indices ─────────────────────────────────────────────────────────
        "/api/indices": {
            get: {
                tags: ["Indices"],
                summary: "Get NIFTY 50, SENSEX, and BANK NIFTY",
                description: "Reads from Redis cache, refreshed in real time over WebSocket and backstopped every 5 minutes by the market worker.",
                responses: {
                    200: {
                        description: "Index data",
                        content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/IndexData" } } } },
                    },
                    500: { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Market ──────────────────────────────────────────────────────────
        "/api/market/status": {
            get: {
                tags: ["Market"],
                summary: "Get current market open/close status",
                description: "Returns IST time, whether NSE is open, and when the next open/close event is.",
                responses: {
                    200: { description: "Market status", content: { "application/json": { schema: { $ref: "#/components/schemas/MarketStatus" } } } },
                },
            },
        },

        // ─── AI ──────────────────────────────────────────────────────────────
        "/api/ai/analyse/{symbol}": {
            get: {
                tags: ["AI"],
                summary: "Get AI-powered analysis for a stock",
                description: "Runs RSI, MACD, and Bollinger Bands server-side, then feeds indicators + live price into an AI engine for per-stock insights.",
                security: [{ bearerAuth: [] }],
                parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string", example: "RELIANCE" } }],
                responses: {
                    200: {
                        description: "AI analysis result",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        symbol: { type: "string", example: "RELIANCE" },
                                        analysis: { type: "string", example: "Bullish momentum with RSI at 62..." },
                                        indicators: {
                                            type: "object",
                                            properties: {
                                                rsi: { type: "number", example: 62.4 },
                                                macd: { type: "object" },
                                                bollingerBands: { type: "object" },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: "Symbol not supported", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    401: { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                    500: { description: "AI engine error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
                },
            },
        },

        // ─── Health ──────────────────────────────────────────────────────────
        "/api/health": {
            get: {
                tags: ["Health"],
                summary: "Server health check",
                responses: {
                    200: {
                        description: "Server is up",
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        status: { type: "string", example: "ok" },
                                        timestamp: { type: "integer", example: 1717000000000 },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};
