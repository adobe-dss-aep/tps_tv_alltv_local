export function coordinateBrowserRedirect(provider, initializeAuth, nonInteractive, log) {
  const redirect = provider.redirectToAuthorization.bind(provider);
  if (nonInteractive) return redirect;

  return async (authorizationUrl) => {
    const { skipBrowserAuth } = await initializeAuth();
    if (skipBrowserAuth) {
      log("ALLTV: another instance completed sign-in; suppressing this browser redirect.");
      return;
    }
    if (authorizationUrl.searchParams.get("redirect_uri") !== String(provider.redirectUrl)) {
      throw new Error("ALLTV callback port changed during sign-in. Configure an explicit callback port.");
    }
    return redirect(authorizationUrl);
  };
}
