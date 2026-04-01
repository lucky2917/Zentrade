import { createContext, useContext, useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

const MarketContext = createContext(null);

const SOCKET_URL = import.meta.env.DEV ? "http://localhost:5001" : "/";

const MarketProvider = ({ children }) => {
    const [prices, setPrices] = useState({});
    const [indices, setIndices] = useState({});
    const [connected, setConnected] = useState(false);
    const [isMarketOpen, setIsMarketOpen] = useState(false);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = io(SOCKET_URL, {
            transports: ["websocket", "polling"],
        });

        socketRef.current = socket;

        socket.on("connect", () => setConnected(true));
        socket.on("disconnect", () => setConnected(false));
        socket.on("prices", (payload) => {
            if (payload.type === "market_update") {
                setPrices(payload.data || {});
                setIndices(payload.indices || {});
                if (payload.isMarketOpen !== undefined) {
                    setIsMarketOpen(payload.isMarketOpen);
                }
            } else {
                setPrices(payload);
            }
        });

        return () => socket.disconnect();
    }, []);

    return (
        <MarketContext.Provider value={{ prices, indices, connected, isMarketOpen }}>
            {children}
        </MarketContext.Provider>
    );
};

const useMarket = () => useContext(MarketContext);

export { MarketProvider, useMarket };

/*
 * real-time market data context. connects to the backend via
 * socket.io and listens for "prices" events that come every
 * 3 seconds. stores all stock prices and index data. Dashboard
 * and StockDetail pages read from here, and Navbar uses the
 * connected flag to show the live/offline indicator.
 */
