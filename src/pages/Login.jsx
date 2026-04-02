import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { useGoogleLogin } from "@react-oauth/google";
import { motion } from "framer-motion";
import { LogIn } from "lucide-react";

const Login = () => {
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const { googleLogin } = useAuth();
    const navigate = useNavigate();

    const handleGoogleLogin = useGoogleLogin({
        flow: "implicit",
        onSuccess: async (tokenResponse) => {
            setError("");
            setLoading(true);
            try {
                await googleLogin(tokenResponse.access_token);
                navigate("/");
            } catch (err) {
                setError(err.response?.data?.error || "Google login failed");
            } finally {
                setLoading(false);
            }
        },
        onError: () => {
            setError("Google login was cancelled");
        },
    });

    return (
        <div className="auth-container">
            <motion.div
                className="auth-card"
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.5, type: "spring", stiffness: 200, damping: 20 }}
            >
                <div className="auth-header">
                    <motion.h1
                        className="auth-logo"
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                    >
                        <span className="logo-zen">Zen</span>
                        <span className="logo-trade">Trade</span>
                    </motion.h1>
                    <p className="auth-subtitle">Paper Trading Platform</p>
                </div>
                <div className="auth-form">
                    <h2>Welcome Back</h2>
                    {error && <div className="auth-error">{error}</div>}

                    <motion.button
                        className="btn-google"
                        onClick={() => handleGoogleLogin()}
                        disabled={loading}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        {loading ? "Signing in..." : "Continue with Google"}
                    </motion.button>
                </div>
            </motion.div>
        </div>
    );
};

export default Login;

/*
 * login page. has a big "continue with google" button at the top
 * which is the main way to sign in. below that theres a divider
 * and the old email/password form as a fallback. uses the implicit
 * flow from @react-oauth/google. on success it sends the access
 * token to our backend and redirects to dashboard.
 */
