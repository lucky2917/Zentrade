import { createContext, useContext, useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

const MarketContext = createContext(null);

const SOCKET_URL = import.meta.env.DEV ? "http://localhost:5001" : "/";

const MarketProvider = ({ children }) => {
    const [prices, setPrices] = useState({});
    const [connected, setConnected] = useState(false);
    const socketRef = useRef(null);

    useEffect(() => {
        const socket = io(SOCKET_URL, {
            transports: ["websocket", "polling"],
        });

        socketRef.current = socket;

        socket.on("connect", () => setConnected(true));
        socket.on("disconnect", () => setConnected(false));
        socket.on("prices", (data) => setPrices(data));

        return () => socket.disconnect();
    }, []);

    return (
        <MarketContext.Provider value={{ prices, connected }}>
            {children}
        </MarketContext.Provider>
    );
};

const useMarket = () => useContext(MarketContext);

export { MarketProvider, useMarket };
