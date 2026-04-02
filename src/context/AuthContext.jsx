import { createContext, useContext, useState, useEffect } from "react";
import api from "../services/api.js";

const AuthContext = createContext(null);

const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(localStorage.getItem("token"));
    const [loading, setLoading] = useState(!!localStorage.getItem("token"));

    useEffect(() => {
        if (token) {
            api
                .get("/portfolio")
                .then((res) => {
                    const stored = localStorage.getItem("user");
                    if (stored) {
                        const parsed = JSON.parse(stored);
                        setUser({ ...parsed, balancePaise: res.data.balancePaise });
                    }
                    setLoading(false);
                })
                .catch(() => {
                    localStorage.removeItem("token");
                    localStorage.removeItem("user");
                    setToken(null);
                    setLoading(false);
                });
        }
    }, [token]);

    const login = async (email, password) => {
        const res = await api.post("/auth/login", { email, password });
        localStorage.setItem("token", res.data.token);
        localStorage.setItem("user", JSON.stringify(res.data.user));
        setToken(res.data.token);
        setUser(res.data.user);
        return res.data;
    };

    const signup = async (email, password) => {
        const res = await api.post("/auth/signup", { email, password });
        localStorage.setItem("token", res.data.token);
        localStorage.setItem("user", JSON.stringify(res.data.user));
        setToken(res.data.token);
        setUser(res.data.user);
        return res.data;
    };

    const googleLogin = async (accessToken) => {
        const res = await api.post("/auth/google", { accessToken });
        localStorage.setItem("token", res.data.token);
        localStorage.setItem("user", JSON.stringify(res.data.user));
        setToken(res.data.token);
        setUser(res.data.user);
        return res.data;
    };

    const logout = () => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        setToken(null);
        setUser(null);
    };

    const refreshBalance = async () => {
        try {
            const res = await api.get("/portfolio");
            setUser((prev) => prev ? { ...prev, balancePaise: res.data.balancePaise } : prev);
        } catch (err) {
            /* silent — navbar balance stays stale until next load */
        }
    };

    return (
        <AuthContext.Provider value={{ user, token, loading, login, signup, googleLogin, logout, refreshBalance }}>
            {children}
        </AuthContext.Provider>
    );
};

const useAuth = () => useContext(AuthContext);

export { AuthProvider, useAuth };

/*
 * auth context with login, signup, google oauth, logout, and
 * refreshBalance. the refreshBalance function re-fetches the
 * wallet from /portfolio so the navbar updates instantly after
 * trades without needing a full page reload. user state includes
 * balancePaise which gets hydrated from the portfolio endpoint
 * on mount and after every refreshBalance call.
 */
