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

    return (
        <AuthContext.Provider value={{ user, token, loading, login, signup, googleLogin, logout }}>
            {children}
        </AuthContext.Provider>
    );
};

const useAuth = () => useContext(AuthContext);

export { AuthProvider, useAuth };

/*
 * auth state management. stores user, token, balance. has login,
 * signup, googleLogin, and logout. the googleLogin method sends
 * the credential from google's button to our backend which verifies
 * it and returns a jwt. on mount it validates stored token by
 * hitting /portfolio. everything that needs the user pulls from useAuth.
 */
