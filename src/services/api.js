import axios from "axios";

const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || "/api",
    withCredentials: true,
});

let isRefreshing = false;
let refreshQueue = [];

const processQueue = (err) => {
    refreshQueue.forEach(({ resolve, reject }) => (err ? reject(err) : resolve()));
    refreshQueue = [];
};

api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const url = error.config?.url || "";
        const isAuthCall = ["/auth/login", "/auth/signup", "/auth/google", "/auth/refresh"].some((p) =>
            url.includes(p)
        );

        if (error.response?.status === 401 && !isAuthCall && !error.config?._retry) {
            // H4: try to refresh before giving up
            if (isRefreshing) {
                return new Promise((resolve, reject) => {
                    refreshQueue.push({ resolve, reject });
                }).then(() => api(error.config));
            }

            error.config._retry = true;
            isRefreshing = true;

            try {
                await api.post("/auth/refresh");
                processQueue(null);
                isRefreshing = false;
                return api(error.config);
            } catch (refreshErr) {
                processQueue(refreshErr);
                isRefreshing = false;
                localStorage.removeItem("user");
                // L5: dispatch event so AuthContext can clear state + let router handle redirect
                window.dispatchEvent(new CustomEvent("zentrade:session-expired"));
            }
        }

        return Promise.reject(error);
    }
);

export default api;
