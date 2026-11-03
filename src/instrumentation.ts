export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertBootAllowed } = await import("./lib/serverConfig");
    assertBootAllowed();
  }
}
