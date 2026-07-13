import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import useGoogleAuth from "../hooks/useGoogleAuth.js";
import GoogleIcon from "../components/GoogleIcon.jsx";
import { motion } from "framer-motion";
import { LogIn } from "lucide-react";

const Login = () => {
    const { user } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        if (user) navigate("/", { replace: true });
    }, [user, navigate]);

    const handleGoogleAuth = useGoogleAuth(() => navigate("/", { replace: true }));

    return (
        <motion.div
            className="login-page"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
            <div className="empty-state glass-panel" style={{ marginTop: "2rem", maxWidth: "420px", marginLeft: "auto", marginRight: "auto" }}>
                <LogIn size={48} className="empty-icon text-muted mb-4" style={{ color: "var(--text-muted)" }} />
                <h2 style={{ marginBottom: "1rem" }}>Login Required</h2>
                <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>Sign in to continue to Zentrade.</p>
                <button className="btn-login-google" style={{ margin: "0 auto", padding: "0.6rem 1.2rem" }} onClick={() => handleGoogleAuth()}>
                    <GoogleIcon />
                    <span style={{ fontSize: "1rem" }}>Continue with Google</span>
                </button>
            </div>
        </motion.div>
    );
};

export default Login;
