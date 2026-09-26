export const now = () => new Date();
export const currentMs = () => Date.now();
export const dateMs = (value) => new Date(value).getTime();
export const iso = (value) => (value ? new Date(value).toISOString() : null);
export const secondsFromNow = (seconds) => new Date(Date.now() + seconds * 1000);
