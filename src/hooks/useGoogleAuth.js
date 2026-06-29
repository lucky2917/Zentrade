import { useGoogleLogin } from "@react-oauth/google";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";

const useGoogleAuth = (onLoginSuccess) => {
    const { googleLogin } = useAuth();
    const { addToast } = useToast();

    return useGoogleLogin({
        flow: "auth-code",
        onSuccess: async (codeResponse) => {
            try {
                await googleLogin(codeResponse.code);
                addToast("Logged in successfully", "success");
                onLoginSuccess?.();
            } catch (err) {
                addToast(err.response?.data?.error || "Login failed", "error");
            }
        },
        onError: () => {
            addToast("Login cancelled", "error");
        },
    });
};

export default useGoogleAuth;
