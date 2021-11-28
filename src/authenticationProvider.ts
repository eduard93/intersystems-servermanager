import {
    authentication,
    AuthenticationProvider,
    AuthenticationProviderAuthenticationSessionsChangeEvent,
    AuthenticationSession,
    Disposable,
    Event,
    EventEmitter,
    extensions,
    SecretStorage,
    ThemeIcon,
    window,
    workspace,
} from "vscode";
import { ServerManagerAuthenticationSession } from "./authenticationSession";
import { globalState } from "./extension";

export const AUTHENTICATION_PROVIDER = "intersystems-server-credentials";
const AUTHENTICATION_PROVIDER_LABEL = "InterSystems Server Credentials";

export class ServerManagerAuthenticationProvider implements AuthenticationProvider, Disposable {
    public static id = AUTHENTICATION_PROVIDER;
    public static label = AUTHENTICATION_PROVIDER_LABEL;
    public static secretKeyPrefix = "credentialProvider:";
    public static sessionId(serverName: string, userName: string): string {
        return `${serverName}/${userName}`;
    }
    public static credentialKey(sessionId: string): string {
        return `${ServerManagerAuthenticationProvider.secretKeyPrefix}${sessionId}`;
    }

    private _initializedDisposable: Disposable | undefined;

    private readonly _secretStorage;

    private _sessions: ServerManagerAuthenticationSession[] = [];

    private _serverManagerExtension = extensions.getExtension("intersystems-community.servermanager");

    private _onDidChangeSessions = new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
    get onDidChangeSessions(): Event<AuthenticationProviderAuthenticationSessionsChangeEvent> {
        return this._onDidChangeSessions.event;
    }

    constructor(private readonly secretStorage: SecretStorage) {
        this._secretStorage = secretStorage;
    }

    public dispose(): void {

        this._initializedDisposable?.dispose();
    }

    // This function is called first when `vscode.authentication.getSessions` is called.
    public async getSessions(scopes: string[] = []): Promise<readonly AuthenticationSession[]> {
        await this._ensureInitialized();
        let sessions = this._sessions;

        // Filter to return only those that match all supplied scopes, which are positional.
        for (let index = 0; index < scopes.length; index++) {
            sessions = sessions.filter((session) => session.scopes[index] === scopes[index]);
        }
        return sessions;
    }

    // This function is called after `this.getSessions` is called, and only when:
    // - `this.getSessions` returns nothing but `createIfNone` was `true` in call to `vscode.authentication.getSession`
    // - `vscode.authentication.getSession` was called with `forceNewSession: true` or
    //   `forceNewSession: {detail: "Reason message for modal dialog"}` (proposed API since 1.59, finalized in 1.63)
    // - The end user initiates the "silent" auth flow via the Accounts menu
    public async createSession(scopes: string[]): Promise<AuthenticationSession> {
        await this._ensureInitialized();

        let serverName = scopes[0] ?? "";
        if (!serverName) {
            // Prompt for the server name.
            if (!this._serverManagerExtension) {
                throw new Error(`InterSystems Server Manager extension is not available to provide server selection for ${AUTHENTICATION_PROVIDER_LABEL}.`);
            }
            if (!this._serverManagerExtension.isActive) {
                await this._serverManagerExtension.activate();
            }
            serverName = await this._serverManagerExtension.exports.pickServer() ?? "";
            if (!serverName) {
                throw new Error(`${AUTHENTICATION_PROVIDER_LABEL}: Server name is required.`);
            }
        }

        let userName = scopes[1] ?? "";
        if (!userName) {
            // Prompt for the username.
            const enteredUserName = await window.showInputBox({
                ignoreFocusOut: true,
                placeHolder: `Username on server '${serverName}'`,
                prompt: "Enter the username to access the InterSystems server with. Leave blank for unauthenticated access as 'UnknownUser'.",
                title: `${AUTHENTICATION_PROVIDER_LABEL}: Username on InterSystems server '${serverName}'`,
            });
            if (typeof enteredUserName === "undefined") {
                throw new Error(`${AUTHENTICATION_PROVIDER_LABEL}: Username is required.`);
            }
            userName = enteredUserName === "" ? "UnknownUser" : enteredUserName;
        }

        // Return existing session if found
        const sessionId = ServerManagerAuthenticationProvider.sessionId(serverName, userName);
        const existingSession = this._sessions.find((s) => s.id === sessionId);
        if (existingSession) {
            return existingSession;
        }

        let password: string | undefined = "";

        if (userName !== "UnknownUser") {
            // Seek password in secret storage
            const credentialKey = ServerManagerAuthenticationProvider.credentialKey(sessionId);
            password =  await this.secretStorage.get(credentialKey);
            if (!password) {
                // Prompt for password
                const doInputBox = async (): Promise<string | undefined> => {
                    return await new Promise<string | undefined>((resolve, reject) => {
                        const inputBox = window.createInputBox();
                        inputBox.value = "";
                        inputBox.password = true;
                        inputBox.title = `${AUTHENTICATION_PROVIDER_LABEL}: Password for user '${userName}'`;
                        inputBox.placeholder = `Password for user '${userName}' on '${serverName}'`;
                        inputBox.prompt = "Optionally use $(key) button above to store password";
                        inputBox.ignoreFocusOut = true;
                        inputBox.buttons = [
                            {
                                iconPath: new ThemeIcon("key"),
                                tooltip: "Store Password Securely in Workstation Keychain",
                            },
                        ];

                        async function done(secretStorage?: SecretStorage) {
                            // Return the password, having stored it if storage was passed
                            const enteredPassword = inputBox.value;
                            if (secretStorage && enteredPassword) {
                                await secretStorage.store(credentialKey, enteredPassword);
                                console.log(`Stored password at ${credentialKey}`);
                            }
                            // Resolve the promise and tidy up
                            resolve(enteredPassword);
                            inputBox.hide();
                            inputBox.dispose();
                        }

                        inputBox.onDidTriggerButton((_button) => {
                            // We only added the one button, which stores the password
                            done(this.secretStorage);
                        });
                        inputBox.onDidAccept(() => {
                            done();
                        });
                        inputBox.show();
                    });
                };
                password = await doInputBox();
                if (!password) {
                    throw new Error(`${AUTHENTICATION_PROVIDER_LABEL}: Password is required.`);
                }
            }
        }

        // We have all we need to create the session object
        const session = new ServerManagerAuthenticationSession(serverName, userName, password);
        // Update this._sessions and raise the event to notify
        const added: AuthenticationSession[] = [];
        const changed: AuthenticationSession[] = [];
        const index = this._sessions.findIndex((item) => item.id === session.id);
        if (index !== -1) {
            this._sessions[index] = session;
            changed.push(session);
        } else {
            this._sessions.push(session);
            added.push(session);
        }
        await this._storeStrippedSessions();
        this._onDidChangeSessions.fire({ added, removed: [], changed });
        return session;
    }

    // This function is called when the end user signs out of the account.
    public async removeSession(sessionId: string): Promise<void> {
        const index = this._sessions.findIndex((item) => item.id === sessionId);
        const session = this._sessions[index];

        let deletePassword = false;
        const credentialKey = ServerManagerAuthenticationProvider.credentialKey(sessionId);
        if (await this.secretStorage.get(credentialKey)) {
            const passwordOption = workspace.getConfiguration("intersystemsServerManager.credentialsProvider")
                .get<string>("deletePasswordOnSignout", "ask");
            deletePassword = (passwordOption === "always");
            if (passwordOption === "ask") {
                const choice = await window.showWarningMessage(
                    `Do you want to keep the password or delete it?`,
                    { detail: `The ${AUTHENTICATION_PROVIDER_LABEL} account you signed out (${session.account.label}) is currently storing its password securely on your workstation.`, modal: true },
                    { title: "Keep", isCloseAffordance: true },
                    { title: "Delete", isCloseAffordance: false },
                );
                deletePassword = (choice?.title === "Delete");
            }
        }
        if (deletePassword) {
            // Delete from secret storage
            await this.secretStorage.delete(credentialKey);
            console.log(`${AUTHENTICATION_PROVIDER_LABEL}: Deleted password at ${credentialKey}`);
        }
        if (index > -1) {
            // Remove session here so we don't store it
            this._sessions.splice(index, 1);
        }
        await this._storeStrippedSessions();
        this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
    }

    private async _ensureInitialized(): Promise<void> {
        if (this._initializedDisposable === undefined) {

            // Get the previously-persisted array of sessions that were stripped of their accessTokens (aka passwords)
            await this._reloadSessions();

            this._initializedDisposable = Disposable.from(
                // This onDidChange event happens when the secret storage changes in _any window_ since
                // secrets are shared across all open windows.
                this.secretStorage.onDidChange(async (e) => {
                    for (const session of this._sessions) {
                        const credentialKey = ServerManagerAuthenticationProvider.credentialKey(session.id);
                        if (credentialKey === e.key) {
                            const password = await this.secretStorage.get(credentialKey);

                            // Only look up the session in _sessions after the await for password has completed,
                            // in case _sessions has been changed elsewhere in the meantime
                            const index = this._sessions.findIndex((sess) => sess.id === session.id );
                            if (index > -1) {
                                if (!password) {
                                    this._sessions.splice(index, 1);
                                }  else {
                                    this._sessions[index] = new ServerManagerAuthenticationSession(
                                        session.serverName,
                                        session.userName,
                                        password,
                                        );
                                }
                            }
                        }
                    }
                }),
                // This fires when the user initiates a "silent" auth flow via the Accounts menu.
                authentication.onDidChangeSessions(async (e) => {
                    if (e.provider.id === ServerManagerAuthenticationProvider.id) {
                        // TODO what, of anything?
                    }
                }),
            );
        }
    }

    private async _reloadSessions() {
        const strippedSessions = globalState.get<ServerManagerAuthenticationSession[]>(
            "authenticationProvider.strippedSessions",
            [],
        );

        // Build our array of sessions for which non-empty accessTokens were securely persisted
        this._sessions = (await Promise.all(
            strippedSessions.map(async (session) => {
                const credentialKey = ServerManagerAuthenticationProvider.credentialKey(session.id);
                const accessToken = await this._secretStorage.get(credentialKey);
                return new ServerManagerAuthenticationSession(session.serverName, session.userName, accessToken);
            }),
        )).filter((session) => session.accessToken);
    }

    private async _storeStrippedSessions() {
        // Build an array of sessions with passwords blanked
        const strippedSessions = this._sessions.map((session) => {
            return new ServerManagerAuthenticationSession(
                session.serverName,
                session.userName,
                "",
            );
        });

        // Persist it
        await globalState.update(
            "authenticationProvider.strippedSessions",
            strippedSessions,
        );
    }
}
