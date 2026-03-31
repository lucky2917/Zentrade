import axios from "axios";

const api = axios.create({
    baseURL: "/api",
});

api.interceptors.request.use((config) => {
    const token = localStorage.getItem("token");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response && error.response.status === 401) {
            localStorage.removeItem("token");
            window.location.href = "/login";
        }
        return Promise.reject(error);
    }
);

export default api;

/*
 * axios instance with /api base url. automatically attaches the
 * jwt token from localstorage to every request. if any response
 * comes back as 401 it clears the token and kicks you to login.
 * every page that talks to the backend imports this.
 */
