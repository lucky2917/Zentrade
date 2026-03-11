import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMarket } from "../context/MarketContext.jsx";
import api from "../services/api.js";

const STOCK_LIST = [
    { symbol: "RELIANCE", name: "Reliance Industries" },
    { symbol: "TCS", name: "Tata Consultancy Services" },
    { symbol: "HDFCBANK", name: "HDFC Bank" },
    { symbol: "INFY", name: "Infosys" },
    { symbol: "ICICIBANK", name: "ICICI Bank" },
    { symbol: "HINDUNILVR", name: "Hindustan Unilever" },
    { symbol: "SBIN", name: "State Bank of India" },
    { symbol: "BHARTIARTL", name: "Bharti Airtel" },
    { symbol: "ITC", name: "ITC" },
    { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank" },
    { symbol: "LT", name: "Larsen & Toubro" },
    { symbol: "HCLTECH", name: "HCL Technologies" },
    { symbol: "AXISBANK", name: "Axis Bank" },
    { symbol: "ASIANPAINT", name: "Asian Paints" },
    { symbol: "MARUTI", name: "Maruti Suzuki" },
    { symbol: "SUNPHARMA", name: "Sun Pharmaceutical" },
    { symbol: "TITAN", name: "Titan Company" },
    { symbol: "BAJFINANCE", name: "Bajaj Finance" },
    { symbol: "DMART", name: "Avenue Supermarts" },
    { symbol: "WIPRO", name: "Wipro" },
    { symbol: "ULTRACEMCO", name: "UltraTech Cement" },
    { symbol: "ONGC", name: "Oil & Natural Gas Corp" },
    { symbol: "NTPC", name: "NTPC" },
    { symbol: "TATAMOTORS", name: "Tata Motors" },
    { symbol: "TATASTEEL", name: "Tata Steel" },
    { symbol: "POWERGRID", name: "Power Grid Corp" },
    { symbol: "M&M", name: "Mahindra & Mahindra" },
    { symbol: "JSWSTEEL", name: "JSW Steel" },
    { symbol: "ADANIENT", name: "Adani Enterprises" },
    { symbol: "ADANIPORTS", name: "Adani Ports" },
    { symbol: "TECHM", name: "Tech Mahindra" },
    { symbol: "HDFCLIFE", name: "HDFC Life Insurance" },
    { symbol: "BAJAJFINSV", name: "Bajaj Finserv" },
    { symbol: "SBILIFE", name: "SBI Life Insurance" },
    { symbol: "GRASIM", name: "Grasim Industries" },
    { symbol: "DIVISLAB", name: "Divi's Laboratories" },
    { symbol: "DRREDDY", name: "Dr. Reddy's Labs" },
    { symbol: "CIPLA", name: "Cipla" },
    { symbol: "EICHERMOT", name: "Eicher Motors" },
    { symbol: "APOLLOHOSP", name: "Apollo Hospitals" },
    { symbol: "COALINDIA", name: "Coal India" },
    { symbol: "BPCL", name: "Bharat Petroleum" },
    { symbol: "BRITANNIA", name: "Britannia Industries" },
    { symbol: "NESTLEIND", name: "Nestle India" },
    { symbol: "TATACONSUM", name: "Tata Consumer Products" },
    { symbol: "HEROMOTOCO", name: "Hero MotoCorp" },
    { symbol: "INDUSINDBK", name: "IndusInd Bank" },
    { symbol: "HINDALCO", name: "Hindalco Industries" },
    { symbol: "UPL", name: "UPL" },
];

const Dashboard = () => {
    const { prices } = useMarket();
    const navigate = useNavigate();
    const [search, setSearch] = useState("");
    const [sortBy, setSortBy] = useState("symbol");
    const [sortDir, setSortDir] = useState("asc");

    const formatPrice = (price) => {
        if (!price) return "—";
        return new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 2,
        }).format(price);
    };

    const filteredStocks = useMemo(() => {
        let result = STOCK_LIST.filter(
            (s) =>
                s.symbol.toLowerCase().includes(search.toLowerCase()) ||
                s.name.toLowerCase().includes(search.toLowerCase())
        );

        result.sort((a, b) => {
            if (sortBy === "symbol") {
                return sortDir === "asc"
                    ? a.symbol.localeCompare(b.symbol)
                    : b.symbol.localeCompare(a.symbol);
            }
            if (sortBy === "price") {
                const priceA = prices[a.symbol]?.price || 0;
                const priceB = prices[b.symbol]?.price || 0;
                return sortDir === "asc" ? priceA - priceB : priceB - priceA;
            }
            if (sortBy === "change") {
                const changeA = prices[a.symbol]?.change || 0;
                const changeB = prices[b.symbol]?.change || 0;
                return sortDir === "asc" ? changeA - changeB : changeB - changeA;
            }
            return 0;
        });

        return result;
    }, [search, sortBy, sortDir, prices]);

    const handleSort = (col) => {
        if (sortBy === col) {
            setSortDir(sortDir === "asc" ? "desc" : "asc");
        } else {
            setSortBy(col);
            setSortDir("asc");
        }
    };

    const getSortIcon = (col) => {
        if (sortBy !== col) return "↕";
        return sortDir === "asc" ? "↑" : "↓";
    };

    return (
        <div className="dashboard">
            <div className="dashboard-header">
                <h1>Markets</h1>
                <div className="search-bar">
                    <input
                        type="text"
                        placeholder="Search stocks..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                </div>
            </div>

            <div className="stock-table-container">
                <table className="stock-table">
                    <thead>
                        <tr>
                            <th onClick={() => handleSort("symbol")} className="sortable">
                                Symbol {getSortIcon("symbol")}
                            </th>
                            <th>Company</th>
                            <th onClick={() => handleSort("price")} className="sortable">
                                Price {getSortIcon("price")}
                            </th>
                            <th onClick={() => handleSort("change")} className="sortable">
                                Change {getSortIcon("change")}
                            </th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredStocks.map((stock) => {
                            const data = prices[stock.symbol];
                            const change = data?.change || 0;
                            const isPositive = change >= 0;

                            return (
                                <tr
                                    key={stock.symbol}
                                    className="stock-row"
                                    onClick={() => navigate(`/stock/${stock.symbol}`)}
                                >
                                    <td className="stock-symbol">{stock.symbol}</td>
                                    <td className="stock-name">{stock.name}</td>
                                    <td className="stock-price">
                                        {data ? formatPrice(data.price) : "—"}
                                    </td>
                                    <td className={`stock-change ${isPositive ? "positive" : "negative"}`}>
                                        {data ? `${isPositive ? "+" : ""}${change.toFixed(2)}%` : "—"}
                                    </td>
                                    <td>
                                        <button
                                            className="btn-trade"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                navigate(`/stock/${stock.symbol}`);
                                            }}
                                        >
                                            Trade
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default Dashboard;
