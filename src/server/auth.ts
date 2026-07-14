export type AuthConfig = { clientId?: string; allowedEmails: string[]; allowUnauthenticated: boolean };
export type AuthUser = { email: string; name?: string };

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  return {
    clientId: undefined,
    allowedEmails: [],
    allowUnauthenticated: env.RATINGS_ALLOW_UNAUTHENTICATED === "true"
  };
}

export async function authenticate(_headers: Headers, config = authConfig()): Promise<AuthUser> {
  if (!config.allowUnauthenticated) {
    throw new Error(
      "Сервис настроен только для единого открытого режима: задайте RATINGS_ALLOW_UNAUTHENTICATED=true"
    );
  }
  return { email: "local@ratings" };
}
