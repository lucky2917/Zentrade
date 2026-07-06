import axios from "axios";

const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || "/api",
    withCredentials: true,
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            // don't redirect during the login/signup flow itself
            const url = error.config?.url || "";
            const isAuthCall = ["/auth/login", "/auth/signup", "/auth/google"].some((p) => url.includes(p));
            if (!isAuthCall) {
                localStorage.removeItem("user");
                window.location.href = "/login";
            }
        }
        return Promise.reject(error);
    }
);

export default api;
