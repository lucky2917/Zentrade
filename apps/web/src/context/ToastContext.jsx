import { createContext, useContext, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, X } from "lucide-react";

const ToastContext = createContext(null);

let toastCount = 0;

export const ToastProvider = ({ children }) => {
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((message, type = "success") => {
        const id = ++toastCount;
        setToasts(prev => [...prev, { id, message, type }]);

        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    const removeToast = useCallback((id) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ addToast }}>
            {children}
            <div className="toast-container">
                <AnimatePresence>
                    {toasts.map(toast => (
                        <motion.div
                            key={toast.id}
                            className={`toast ${toast.type}`}
                            initial={{ opacity: 0, x: 50, scale: 0.9 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 50, scale: 0.9 }}
                            transition={{ type: "spring", stiffness: 400, damping: 25 }}
                        >
                            <div className="toast-icon">
                                {toast.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                            </div>
                            <span className="toast-text">{toast.message}</span>
                            <button className="toast-close" onClick={() => removeToast(toast.id)}>
                                <X size={14} />
                            </button>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </ToastContext.Provider>
    );
};

export const useToast = () => useContext(ToastContext);

/*
 * global toast notification provider. drops floating bubbles on the
 * bottom right of the screen for trade successes, errors, and auth
 * events. auto dismisses after 4 seconds and handles all the slick
 * framer motion spring animations so it feels super premium.
 */
