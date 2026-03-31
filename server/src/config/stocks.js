const STOCKS = [
    { symbol: "RELIANCE", yahooSymbol: "RELIANCE.NS", name: "Reliance Industries" },
    { symbol: "TCS", yahooSymbol: "TCS.NS", name: "Tata Consultancy Services" },
    { symbol: "HDFCBANK", yahooSymbol: "HDFCBANK.NS", name: "HDFC Bank" },
    { symbol: "INFY", yahooSymbol: "INFY.NS", name: "Infosys" },
    { symbol: "ICICIBANK", yahooSymbol: "ICICIBANK.NS", name: "ICICI Bank" },
    { symbol: "HINDUNILVR", yahooSymbol: "HINDUNILVR.NS", name: "Hindustan Unilever" },
    { symbol: "SBIN", yahooSymbol: "SBIN.NS", name: "State Bank of India" },
    { symbol: "BHARTIARTL", yahooSymbol: "BHARTIARTL.NS", name: "Bharti Airtel" },
    { symbol: "ITC", yahooSymbol: "ITC.NS", name: "ITC" },
    { symbol: "KOTAKBANK", yahooSymbol: "KOTAKBANK.NS", name: "Kotak Mahindra Bank" },
    { symbol: "LT", yahooSymbol: "LT.NS", name: "Larsen & Toubro" },
    { symbol: "HCLTECH", yahooSymbol: "HCLTECH.NS", name: "HCL Technologies" },
    { symbol: "AXISBANK", yahooSymbol: "AXISBANK.NS", name: "Axis Bank" },
    { symbol: "ASIANPAINT", yahooSymbol: "ASIANPAINT.NS", name: "Asian Paints" },
    { symbol: "MARUTI", yahooSymbol: "MARUTI.NS", name: "Maruti Suzuki" },
    { symbol: "SUNPHARMA", yahooSymbol: "SUNPHARMA.NS", name: "Sun Pharmaceutical" },
    { symbol: "TITAN", yahooSymbol: "TITAN.NS", name: "Titan Company" },
    { symbol: "BAJFINANCE", yahooSymbol: "BAJFINANCE.NS", name: "Bajaj Finance" },
    { symbol: "DMART", yahooSymbol: "DMART.NS", name: "Avenue Supermarts" },
    { symbol: "WIPRO", yahooSymbol: "WIPRO.NS", name: "Wipro" },
    { symbol: "ULTRACEMCO", yahooSymbol: "ULTRACEMCO.NS", name: "UltraTech Cement" },
    { symbol: "ONGC", yahooSymbol: "ONGC.NS", name: "Oil & Natural Gas Corp" },
    { symbol: "NTPC", yahooSymbol: "NTPC.NS", name: "NTPC" },
    { symbol: "TATAMOTORS", yahooSymbol: "TATAMOTORS.NS", name: "Tata Motors" },
    { symbol: "TATASTEEL", yahooSymbol: "TATASTEEL.NS", name: "Tata Steel" },
    { symbol: "POWERGRID", yahooSymbol: "POWERGRID.NS", name: "Power Grid Corp" },
    { symbol: "M&M", yahooSymbol: "M&M.NS", name: "Mahindra & Mahindra" },
    { symbol: "JSWSTEEL", yahooSymbol: "JSWSTEEL.NS", name: "JSW Steel" },
    { symbol: "ADANIENT", yahooSymbol: "ADANIENT.NS", name: "Adani Enterprises" },
    { symbol: "ADANIPORTS", yahooSymbol: "ADANIPORTS.NS", name: "Adani Ports" },
    { symbol: "TECHM", yahooSymbol: "TECHM.NS", name: "Tech Mahindra" },
    { symbol: "HDFCLIFE", yahooSymbol: "HDFCLIFE.NS", name: "HDFC Life Insurance" },
    { symbol: "BAJAJFINSV", yahooSymbol: "BAJAJFINSV.NS", name: "Bajaj Finserv" },
    { symbol: "SBILIFE", yahooSymbol: "SBILIFE.NS", name: "SBI Life Insurance" },
    { symbol: "GRASIM", yahooSymbol: "GRASIM.NS", name: "Grasim Industries" },
    { symbol: "DIVISLAB", yahooSymbol: "DIVISLAB.NS", name: "Divi's Laboratories" },
    { symbol: "DRREDDY", yahooSymbol: "DRREDDY.NS", name: "Dr. Reddy's Labs" },
    { symbol: "CIPLA", yahooSymbol: "CIPLA.NS", name: "Cipla" },
    { symbol: "EICHERMOT", yahooSymbol: "EICHERMOT.NS", name: "Eicher Motors" },
    { symbol: "APOLLOHOSP", yahooSymbol: "APOLLOHOSP.NS", name: "Apollo Hospitals" },
    { symbol: "COALINDIA", yahooSymbol: "COALINDIA.NS", name: "Coal India" },
    { symbol: "BPCL", yahooSymbol: "BPCL.NS", name: "Bharat Petroleum" },
    { symbol: "BRITANNIA", yahooSymbol: "BRITANNIA.NS", name: "Britannia Industries" },
    { symbol: "NESTLEIND", yahooSymbol: "NESTLEIND.NS", name: "Nestle India" },
    { symbol: "TATACONSUM", yahooSymbol: "TATACONSUM.NS", name: "Tata Consumer Products" },
    { symbol: "HEROMOTOCO", yahooSymbol: "HEROMOTOCO.NS", name: "Hero MotoCorp" },
    { symbol: "INDUSINDBK", yahooSymbol: "INDUSINDBK.NS", name: "IndusInd Bank" },
    { symbol: "HINDALCO", yahooSymbol: "HINDALCO.NS", name: "Hindalco Industries" },
    { symbol: "WIPRO", yahooSymbol: "WIPRO.NS", name: "Wipro" },
    { symbol: "UPL", yahooSymbol: "UPL.NS", name: "UPL" },
];

const STOCK_MAP = new Map(STOCKS.map((s) => [s.symbol, s]));

export { STOCKS, STOCK_MAP };

/*
 * master list of all 50 nifty stocks we track. each entry has our
 * internal symbol, the yahoo finance symbol (with .NS suffix), and
 * the company name. STOCK_MAP is just a quick lookup version of the
 * same list. marketWorker, websocket, trading engine, and a bunch
 * of route files pull from here.
 */
