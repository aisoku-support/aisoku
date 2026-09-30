export const NEWS_CACHE_JOB_AUTH_HEADER = "x-news-cache-job-secret";

export function isAuthorizedNewsCacheJob(
  request: Request,
  secret: string | undefined,
) {
  return Boolean(secret) &&
    request.headers.get(NEWS_CACHE_JOB_AUTH_HEADER) === secret;
}

export function withNewsCacheJobAuth(
  getSecret: () => string | undefined,
  handler: (request: Request) => Promise<Response>,
) {
  return async (request: Request) => {
    if (!isAuthorizedNewsCacheJob(request, getSecret())) {
      return new Response("Unauthorized", { status: 401 });
    }
    return await handler(request);
  };
}
