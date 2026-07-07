import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api.js";

const AuthContext = createContext(null);

const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    // Only show loading spinner if we might have a live session (user object cached)
    const [loading, setLoading] = useState(() => !!localStorage.getItem("user"));

    useEffect(() => {
        // remove pre-migration token key if still present
        localStorage.removeItem("token");

        if (!loading) return;
        api.get("/auth/me")
            .then((res) => {
                const { balancePaise, ...safeUser } = res.data;
                localStorage.setItem("user", JSON.stringify(safeUser));
                setUser(res.data);
            })
            .catch(() => {
                localStorage.removeItem("user");
            })
            .finally(() => setLoading(false));
    }, []);

    const cacheUser = (u) => {
        const { balancePaise, ...safeUser } = u;
        localStorage.setItem("user", JSON.stringify(safeUser));
    };

    const login = async (email, password) => {
        const res = await api.post("/auth/login", { email, password });
        cacheUser(res.data.user);
        setUser(res.data.user);
        return res.data;
    };

    const signup = async (email, password) => {
        const res = await api.post("/auth/signup", { email, password });
        cacheUser(res.data.user);
        setUser(res.data.user);
        return res.data;
    };

    const googleLogin = async (code) => {
        const res = await api.post("/auth/google", { code });
        cacheUser(res.data.user);
        setUser(res.data.user);
        return res.data;
    };

    const logout = async () => {
        await api.post("/auth/logout").catch(() => {});
        localStorage.removeItem("user");
        setUser(null);
    };

    const refreshBalance = async () => {
        try {
            const res = await api.get("/portfolio");
            setUser((prev) => prev ? { ...prev, balancePaise: res.data.balancePaise } : prev);
        } catch {
            /* silent */
        }
    };

    return (
        <AuthContext.Provider value={{ user, loading, login, signup, googleLogin, logout, refreshBalance }}>
            {children}
        </AuthContext.Provider>
    );
};

const useAuth = () => useContext(AuthContext);

export { AuthProvider, useAuth };
