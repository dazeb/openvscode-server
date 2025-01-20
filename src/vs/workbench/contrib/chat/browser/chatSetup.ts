/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatViewSetup.css';
import { $, getActiveElement, setVisibility } from '../../../../base/browser/dom.js';
import { Button, ButtonWithDropdown } from '../../../../base/browser/ui/button/button.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { IAction, toAction, WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../base/common/actions.js';
import { Barrier, timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../base/common/lazy.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IRequestContext } from '../../../../base/parts/request/common/request.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { MarkdownRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import product from '../../../../platform/product/common/product.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService, TelemetryLevel } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IActivityService, ProgressBadge } from '../../../services/activity/common/activity.js';
import { AuthenticationSession, IAuthenticationExtensionsService, IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IWorkbenchExtensionEnablementService } from '../../../services/extensionManagement/common/extensionManagement.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IExtensionsWorkbenchService } from '../../extensions/common/extensions.js';
import { IChatAgentService } from '../common/chatAgents.js';
import { ChatContextKeys } from '../common/chatContextKeys.js';
import { CHAT_CATEGORY } from './actions/chatActions.js';
import { ChatViewId, EditsViewId, ensureSideBarChatViewSize, IChatWidget, showChatView, showEditsView } from './chat.js';
import { CHAT_EDITING_SIDEBAR_PANEL_ID, CHAT_SIDEBAR_PANEL_ID } from './chatViewPane.js';
import { ChatViewsWelcomeExtensions, IChatViewsWelcomeContributionRegistry } from './viewsWelcome/chatViewsWelcome.js';
import { IChatQuotasService } from './chatQuotasService.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { IHostService } from '../../../services/host/browser/host.js';
import Severity from '../../../../base/common/severity.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { isWeb } from '../../../../base/common/platform.js';
import { ExtensionUrlHandlerOverrideRegistry } from '../../../services/extensions/browser/extensionUrlHandler.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	documentationUrl: product.defaultChatAgent?.documentationUrl ?? '',
	termsStatementUrl: product.defaultChatAgent?.termsStatementUrl ?? '',
	privacyStatementUrl: product.defaultChatAgent?.privacyStatementUrl ?? '',
	skusDocumentationUrl: product.defaultChatAgent?.skusDocumentationUrl ?? '',
	publicCodeMatchesUrl: product.defaultChatAgent?.publicCodeMatchesUrl ?? '',
	upgradePlanUrl: product.defaultChatAgent?.upgradePlanUrl ?? '',
	providerIds: [product.defaultChatAgent?.providerId ?? '', 'github-enterprise'],
	providerName: product.defaultChatAgent?.providerName ?? '',
	providerScopes: product.defaultChatAgent?.providerScopes ?? [[]],
	entitlementUrl: product.defaultChatAgent?.entitlementUrl ?? '',
	entitlementSignupLimitedUrl: product.defaultChatAgent?.entitlementSignupLimitedUrl ?? '',
	manageSettingsUrl: product.defaultChatAgent?.manageSettingsUrl ?? '',
};

enum ChatEntitlement {
	/** Signed out */
	Unknown = 1,
	/** Signed in but not yet resolved */
	Unresolved,
	/** Signed in and entitled to Limited */
	Available,
	/** Signed in but not entitled to Limited */
	Unavailable,
	/** Signed-up to Limited */
	Limited,
	/** Signed-up to Pro */
	Pro
}

//#region Contribution

const TRIGGER_SETUP_COMMAND_ID = 'workbench.action.chat.triggerSetup';
const TRIGGER_SETUP_COMMAND_LABEL = localize2('triggerChatSetup', "Use AI Features with Copilot for Free...");

export class ChatSetupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.chat.setup';

	private readonly context = this._register(this.instantiationService.createInstance(ChatSetupContext));
	private readonly requests = this._register(this.instantiationService.createInstance(ChatSetupRequests, this.context));
	private readonly controller = new Lazy(() => this._register(this.instantiationService.createInstance(ChatSetupController, this.context, this.requests)));

	constructor(
		@IProductService private readonly productService: IProductService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@ICommandService private readonly commandService: ICommandService,
		@ITelemetryService private readonly telemetryService: ITelemetryService
	) {
		super();

		if (
			!this.productService.defaultChatAgent ||			// needs product config
			(isWeb && !this.environmentService.remoteAuthority)	// only enabled locally or a remote backend
		) {
			return;
		}

		this.registerChatWelcome();
		this.registerActions();
		this.registerUrlLinkHandler();
	}

	private registerChatWelcome(): void {
		Registry.as<IChatViewsWelcomeContributionRegistry>(ChatViewsWelcomeExtensions.ChatViewsWelcomeRegistry).register({
			title: localize('welcomeChat', "Welcome to Copilot"),
			when: ChatContextKeys.SetupViewCondition,
			icon: Codicon.copilotLarge,
			content: disposables => disposables.add(this.instantiationService.createInstance(ChatSetupWelcomeContent, this.controller.value, this.context)).element,
		});
	}

	private registerActions(): void {
		const that = this;

		const chatSetupTriggerContext = ContextKeyExpr.or(
			ChatContextKeys.Setup.installed.negate(),
			ChatContextKeys.Setup.canSignUp
		);
		class ChatSetupTriggerAction extends Action2 {

			constructor() {
				super({
					id: TRIGGER_SETUP_COMMAND_ID,
					title: TRIGGER_SETUP_COMMAND_LABEL,
					category: CHAT_CATEGORY,
					f1: true,
					precondition: chatSetupTriggerContext,
					menu: {
						id: MenuId.ChatCommandCenter,
						group: 'a_last',
						order: 1,
						when: chatSetupTriggerContext
					}
				});
			}

			override async run(accessor: ServicesAccessor, startSetup: boolean | undefined): Promise<void> {
				const viewsService = accessor.get(IViewsService);
				const viewDescriptorService = accessor.get(IViewDescriptorService);
				const configurationService = accessor.get(IConfigurationService);
				const layoutService = accessor.get(IWorkbenchLayoutService);

				await that.context.update({ hidden: false });

				showCopilotView(viewsService, layoutService);
				ensureSideBarChatViewSize(viewDescriptorService, layoutService);

				if (startSetup === true) {
					that.controller.value.setup();
				}

				configurationService.updateValue('chat.commandCenter.enabled', true);
			}
		}

		class ChatSetupHideAction extends Action2 {

			static readonly ID = 'workbench.action.chat.hideSetup';
			static readonly TITLE = localize2('hideChatSetup', "Hide Copilot");

			constructor() {
				super({
					id: ChatSetupHideAction.ID,
					title: ChatSetupHideAction.TITLE,
					f1: true,
					category: CHAT_CATEGORY,
					precondition: ChatContextKeys.Setup.installed.negate(),
					menu: {
						id: MenuId.ChatCommandCenter,
						group: 'z_hide',
						order: 1,
						when: ChatContextKeys.Setup.installed.negate()
					}
				});
			}

			override async run(accessor: ServicesAccessor): Promise<void> {
				const viewsDescriptorService = accessor.get(IViewDescriptorService);
				const layoutService = accessor.get(IWorkbenchLayoutService);
				const configurationService = accessor.get(IConfigurationService);
				const dialogService = accessor.get(IDialogService);

				const { confirmed } = await dialogService.confirm({
					message: localize('hideChatSetupConfirm', "Are you sure you want to hide Copilot?"),
					detail: localize('hideChatSetupDetail', "You can restore Copilot by running the '{0}' command.", TRIGGER_SETUP_COMMAND_LABEL.value),
					primaryButton: localize('hideChatSetupButton', "Hide Copilot")
				});

				if (!confirmed) {
					return;
				}

				await hideSetupView(viewsDescriptorService, layoutService);

				configurationService.updateValue('chat.commandCenter.enabled', false);
			}
		}

		const windowFocusListener = this._register(new MutableDisposable());
		class UpgradePlanAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.chat.upgradePlan',
					title: localize2('managePlan', "Upgrade to Copilot Pro"),
					category: localize2('chat.category', 'Chat'),
					f1: true,
					precondition: ContextKeyExpr.or(
						ChatContextKeys.Setup.canSignUp,
						ChatContextKeys.Setup.limited,
					),
					menu: {
						id: MenuId.ChatCommandCenter,
						group: 'a_first',
						order: 1,
						when: ContextKeyExpr.or(
							ChatContextKeys.chatQuotaExceeded,
							ChatContextKeys.completionsQuotaExceeded
						)
					}
				});
			}

			override async run(accessor: ServicesAccessor): Promise<void> {
				const openerService = accessor.get(IOpenerService);
				const telemetryService = accessor.get(ITelemetryService);
				const hostService = accessor.get(IHostService);
				const commandService = accessor.get(ICommandService);

				telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: this.desc.id, from: 'chat' });

				openerService.open(URI.parse(defaultChat.upgradePlanUrl));

				const entitlement = that.context.state.entitlement;
				if (entitlement !== ChatEntitlement.Pro) {
					// If the user is not yet Pro, we listen to window focus to refresh the token
					// when the user has come back to the window assuming the user signed up.
					windowFocusListener.value = hostService.onDidChangeFocus(focus => this.onWindowFocus(focus, commandService));
				}
			}

			private async onWindowFocus(focus: boolean, commandService: ICommandService): Promise<void> {
				if (focus) {
					windowFocusListener.clear();

					const entitlement = await that.requests.forceResolveEntitlement(undefined);
					if (entitlement === ChatEntitlement.Pro) {
						refreshTokens(commandService);
					}
				}
			}
		}

		async function hideSetupView(viewsDescriptorService: IViewDescriptorService, layoutService: IWorkbenchLayoutService): Promise<void> {
			const location = viewsDescriptorService.getViewLocationById(ChatViewId);

			await that.context.update({ hidden: true });

			if (location === ViewContainerLocation.AuxiliaryBar) {
				const activeContainers = viewsDescriptorService.getViewContainersByLocation(location).filter(container => viewsDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0);
				if (activeContainers.length === 0) {
					layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART); // hide if there are no views in the secondary sidebar
				}
			}
		}

		registerAction2(ChatSetupTriggerAction);
		registerAction2(ChatSetupHideAction);
		registerAction2(UpgradePlanAction);
	}

	private registerUrlLinkHandler(): void {
		this._register(ExtensionUrlHandlerOverrideRegistry.registerHandler(URI.parse(`${this.productService.urlProtocol}://${defaultChat.chatExtensionId}`), {
			handleURL: async () => {
				this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: TRIGGER_SETUP_COMMAND_ID, from: 'url' });

				await this.commandService.executeCommand(TRIGGER_SETUP_COMMAND_ID);

				return true;
			}
		}));
	}
}

//#endregion

//#region Chat Setup Request Service

type EntitlementClassification = {
	entitlement: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Flag indicating the chat entitlement state' };
	quotaChat: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The number of chat completions available to the user' };
	quotaCompletions: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The number of chat completions available to the user' };
	quotaResetDate: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The date the quota will reset' };
	owner: 'bpasero';
	comment: 'Reporting chat setup entitlements';
};

type EntitlementEvent = {
	entitlement: ChatEntitlement;
	quotaChat: number | undefined;
	quotaCompletions: number | undefined;
	quotaResetDate: string | undefined;
};

interface IEntitlementsResponse {
	readonly access_type_sku: string;
	readonly assigned_date: string;
	readonly can_signup_for_limited: boolean;
	readonly chat_enabled: boolean;
	readonly limited_user_quotas?: {
		readonly chat: number;
		readonly completions: number;
	};
	readonly limited_user_reset_date: string;
}

interface IQuotas {
	readonly chat?: number;
	readonly completions?: number;
	readonly resetDate?: string;
}

interface IChatEntitlements {
	readonly entitlement: ChatEntitlement;
	readonly quotas?: IQuotas;
}

class ChatSetupRequests extends Disposable {

	private state: IChatEntitlements = { entitlement: this.context.state.entitlement };

	private pendingResolveCts = new CancellationTokenSource();
	private didResolveEntitlements = false;

	constructor(
		private readonly context: ChatSetupContext,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
		@IRequestService private readonly requestService: IRequestService,
		@IChatQuotasService private readonly chatQuotasService: IChatQuotasService,
		@IDialogService private readonly dialogService: IDialogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		this.registerListeners();

		this.resolve();
	}

	private registerListeners(): void {
		this._register(this.authenticationService.onDidChangeDeclaredProviders(() => this.resolve()));

		this._register(this.authenticationService.onDidChangeSessions(e => {
			if (defaultChat.providerIds.includes(e.providerId)) {
				this.resolve();
			}
		}));

		this._register(this.authenticationService.onDidRegisterAuthenticationProvider(e => {
			if (defaultChat.providerIds.includes(e.id)) {
				this.resolve();
			}
		}));

		this._register(this.authenticationService.onDidUnregisterAuthenticationProvider(e => {
			if (defaultChat.providerIds.includes(e.id)) {
				this.resolve();
			}
		}));

		this._register(this.context.onDidChange(() => {
			if (!this.context.state.installed || this.context.state.entitlement === ChatEntitlement.Unknown) {
				// When the extension is not installed or the user is not entitled
				// make sure to clear quotas so that any indicators are also gone
				this.state = { entitlement: this.state.entitlement, quotas: undefined };
				this.chatQuotasService.clearQuotas();
			}
		}));
	}

	private async resolve(): Promise<void> {
		this.pendingResolveCts.dispose(true);
		const cts = this.pendingResolveCts = new CancellationTokenSource();

		const session = await this.findMatchingProviderSession(cts.token);
		if (cts.token.isCancellationRequested) {
			return;
		}

		// Immediately signal whether we have a session or not
		let state: IChatEntitlements | undefined = undefined;
		if (session) {
			// Do not overwrite any state we have already
			if (this.state.entitlement === ChatEntitlement.Unknown) {
				state = { entitlement: ChatEntitlement.Unresolved };
			}
		} else {
			this.didResolveEntitlements = false; // reset so that we resolve entitlements fresh when signed in again
			state = { entitlement: ChatEntitlement.Unknown };
		}
		if (state) {
			this.update(state);
		}

		if (session && !this.didResolveEntitlements) {
			// Afterwards resolve entitlement with a network request
			// but only unless it was not already resolved before.
			await this.resolveEntitlement(session, cts.token);
		}
	}

	private async findMatchingProviderSession(token: CancellationToken): Promise<AuthenticationSession | undefined> {
		const authProviders: string[] = [];
		const configuredAuthProvider = this.configurationService.getValue<string | undefined>('github.copilot.advanced.authProvider');
		if (configuredAuthProvider) {
			authProviders.push(configuredAuthProvider);
		} else {
			authProviders.push(...defaultChat.providerIds);
		}

		let sessions: ReadonlyArray<AuthenticationSession> = [];
		for (const authProvider of authProviders) {
			if (token.isCancellationRequested) {
				return undefined;
			}

			sessions = await this.doGetSessions(authProvider);

			if (token.isCancellationRequested) {
				return undefined;
			}

			for (const session of sessions) {
				for (const scopes of defaultChat.providerScopes) {
					if (this.scopesMatch(session.scopes, scopes)) {
						return session;
					}
				}
			}
		}

		return undefined;
	}

	private async doGetSessions(providerId: string): Promise<readonly AuthenticationSession[]> {
		try {
			return await this.authenticationService.getSessions(providerId);
		} catch (error) {
			// ignore - errors can throw if a provider is not registered
		}

		return [];
	}

	private scopesMatch(scopes: ReadonlyArray<string>, expectedScopes: string[]): boolean {
		return scopes.length === expectedScopes.length && expectedScopes.every(scope => scopes.includes(scope));
	}

	private async resolveEntitlement(session: AuthenticationSession, token: CancellationToken): Promise<ChatEntitlement | undefined> {
		const entitlements = await this.doResolveEntitlement(session, token);
		if (typeof entitlements?.entitlement === 'number' && !token.isCancellationRequested) {
			this.didResolveEntitlements = true;
			this.update(entitlements);
		}

		return entitlements?.entitlement;
	}

	private async doResolveEntitlement(session: AuthenticationSession, token: CancellationToken): Promise<IChatEntitlements | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const response = await this.request(defaultChat.entitlementUrl, 'GET', undefined, session, token);
		if (token.isCancellationRequested) {
			return undefined;
		}

		if (!response) {
			this.logService.trace('[chat setup] entitlement: no response');
			return { entitlement: ChatEntitlement.Unresolved };
		}

		if (response.res.statusCode && response.res.statusCode !== 200) {
			this.logService.trace(`[chat setup] entitlement: unexpected status code ${response.res.statusCode}`);
			return { entitlement: ChatEntitlement.Unresolved };
		}

		let responseText: string | null = null;
		try {
			responseText = await asText(response);
		} catch (error) {
			// ignore - handled below
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		if (!responseText) {
			this.logService.trace('[chat setup] entitlement: response has no content');
			return { entitlement: ChatEntitlement.Unresolved };
		}

		let entitlementsResponse: IEntitlementsResponse;
		try {
			entitlementsResponse = JSON.parse(responseText);
			this.logService.trace(`[chat setup] entitlement: parsed result is ${JSON.stringify(entitlementsResponse)}`);
		} catch (err) {
			this.logService.trace(`[chat setup] entitlement: error parsing response (${err})`);
			return { entitlement: ChatEntitlement.Unresolved };
		}

		let entitlement: ChatEntitlement;
		if (entitlementsResponse.access_type_sku === 'free_limited_copilot') {
			entitlement = ChatEntitlement.Limited;
		} else if (entitlementsResponse.can_signup_for_limited) {
			entitlement = ChatEntitlement.Available;
		} else if (entitlementsResponse.chat_enabled) {
			entitlement = ChatEntitlement.Pro;
		} else {
			entitlement = ChatEntitlement.Unavailable;
		}

		const entitlements: IChatEntitlements = {
			entitlement,
			quotas: {
				chat: entitlementsResponse.limited_user_quotas?.chat,
				completions: entitlementsResponse.limited_user_quotas?.completions,
				resetDate: entitlementsResponse.limited_user_reset_date
			}
		};

		this.logService.trace(`[chat setup] entitlement: resolved to ${entitlements.entitlement}, quotas: ${JSON.stringify(entitlements.quotas)}`);
		this.telemetryService.publicLog2<EntitlementEvent, EntitlementClassification>('chatInstallEntitlement', {
			entitlement: entitlements.entitlement,
			quotaChat: entitlementsResponse.limited_user_quotas?.chat,
			quotaCompletions: entitlementsResponse.limited_user_quotas?.completions,
			quotaResetDate: entitlementsResponse.limited_user_reset_date
		});

		return entitlements;
	}

	private async request(url: string, type: 'GET', body: undefined, session: AuthenticationSession, token: CancellationToken): Promise<IRequestContext | undefined>;
	private async request(url: string, type: 'POST', body: object, session: AuthenticationSession, token: CancellationToken): Promise<IRequestContext | undefined>;
	private async request(url: string, type: 'GET' | 'POST', body: object | undefined, session: AuthenticationSession, token: CancellationToken): Promise<IRequestContext | undefined> {
		try {
			return await this.requestService.request({
				type,
				url,
				data: type === 'POST' ? JSON.stringify(body) : undefined,
				disableCache: true,
				headers: {
					'Authorization': `Bearer ${session.accessToken}`
				}
			}, token);
		} catch (error) {
			this.logService.error(`[chat setup] request: error ${error}`);

			return undefined;
		}
	}

	private update(state: IChatEntitlements): void {
		this.state = state;

		this.context.update({ entitlement: this.state.entitlement });

		if (state.quotas) {
			this.chatQuotasService.acceptQuotas({
				chatQuotaExceeded: typeof state.quotas.chat === 'number' ? state.quotas.chat <= 0 : false,
				completionsQuotaExceeded: typeof state.quotas.completions === 'number' ? state.quotas.completions <= 0 : false,
				quotaResetDate: state.quotas.resetDate ? new Date(state.quotas.resetDate) : undefined
			});
		}
	}

	async forceResolveEntitlement(session: AuthenticationSession | undefined): Promise<ChatEntitlement | undefined> {
		if (!session) {
			session = await this.findMatchingProviderSession(CancellationToken.None);
		}

		if (!session) {
			return undefined;
		}

		return this.resolveEntitlement(session, CancellationToken.None);
	}

	async signUpLimited(session: AuthenticationSession): Promise<true /* signed up */ | false /* already signed up */ | { errorCode: number } /* error */> {
		const body = {
			restricted_telemetry: this.telemetryService.telemetryLevel === TelemetryLevel.NONE ? 'disabled' : 'enabled',
			public_code_suggestions: 'enabled'
		};

		const response = await this.request(defaultChat.entitlementSignupLimitedUrl, 'POST', body, session, CancellationToken.None);
		if (!response) {
			const retry = await this.onUnknownSignUpError(localize('signUpNoResponseError', "No response received."), '[chat setup] sign-up: no response');
			return retry ? this.signUpLimited(session) : { errorCode: 1 };
		}

		if (response.res.statusCode && response.res.statusCode !== 200) {
			if (response.res.statusCode === 422) {
				try {
					const responseText = await asText(response);
					if (responseText) {
						const responseError: { message: string } = JSON.parse(responseText);
						if (typeof responseError.message === 'string' && responseError.message) {
							this.onUnprocessableSignUpError(`[chat setup] sign-up: unprocessable entity (${responseError.message})`, responseError.message);
							return { errorCode: response.res.statusCode };
						}
					}
				} catch (error) {
					// ignore - handled below
				}
			}
			const retry = await this.onUnknownSignUpError(localize('signUpUnexpectedStatusError', "Unexpected status code {0}.", response.res.statusCode), `[chat setup] sign-up: unexpected status code ${response.res.statusCode}`);
			return retry ? this.signUpLimited(session) : { errorCode: response.res.statusCode };
		}

		let responseText: string | null = null;
		try {
			responseText = await asText(response);
		} catch (error) {
			// ignore - handled below
		}

		if (!responseText) {
			const retry = await this.onUnknownSignUpError(localize('signUpNoResponseContentsError', "Response has no contents."), '[chat setup] sign-up: response has no content');
			return retry ? this.signUpLimited(session) : { errorCode: 2 };
		}

		let parsedResult: { subscribed: boolean } | undefined = undefined;
		try {
			parsedResult = JSON.parse(responseText);
			this.logService.trace(`[chat setup] sign-up: response is ${responseText}`);
		} catch (err) {
			const retry = await this.onUnknownSignUpError(localize('signUpInvalidResponseError', "Invalid response contents."), `[chat setup] sign-up: error parsing response (${err})`);
			return retry ? this.signUpLimited(session) : { errorCode: 3 };
		}

		// We have made it this far, so the user either did sign-up or was signed-up already.
		// That is, because the endpoint throws in all other case according to Patrick.
		this.update({ entitlement: ChatEntitlement.Limited });

		return Boolean(parsedResult?.subscribed);
	}

	private async onUnknownSignUpError(detail: string, logMessage: string): Promise<boolean> {
		this.logService.error(logMessage);

		const { confirmed } = await this.dialogService.confirm({
			type: Severity.Error,
			message: localize('unknownSignUpError', "An error occurred while signing up for Copilot Free. Would you like to try again?"),
			detail,
			primaryButton: localize('retry', "Retry")
		});

		return confirmed;
	}

	private onUnprocessableSignUpError(logMessage: string, logDetails: string): void {
		this.logService.error(logMessage);

		this.dialogService.prompt({
			type: Severity.Error,
			message: localize('unprocessableSignUpError', "An error occurred while signing up for Copilot Free."),
			detail: logDetails,
			buttons: [
				{
					label: localize('ok', "OK"),
					run: () => { /* noop */ }
				},
				{
					label: localize('learnMore', "Learn More"),
					run: () => this.openerService.open(URI.parse(defaultChat.upgradePlanUrl))
				}
			]
		});
	}

	override dispose(): void {
		this.pendingResolveCts.dispose(true);

		super.dispose();
	}
}

//#endregion

//#region Setup Rendering

type InstallChatClassification = {
	owner: 'bpasero';
	comment: 'Provides insight into chat installation.';
	installResult: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the extension was installed successfully, cancelled or failed to install.' };
	signUpErrorCode: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The error code in case of an error signing up.' };
};
type InstallChatEvent = {
	installResult: 'installed' | 'cancelled' | 'failedInstall' | 'failedNotSignedIn' | 'failedSignUp' | 'failedNotTrusted' | 'failedNoSession';
	signUpErrorCode: number | undefined;
};

enum ChatSetupStep {
	Initial = 1,
	SigningIn,
	Installing
}

class ChatSetupController extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _step = ChatSetupStep.Initial;
	get step(): ChatSetupStep { return this._step; }

	constructor(
		private readonly context: ChatSetupContext,
		private readonly requests: ChatSetupRequests,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IAuthenticationExtensionsService private readonly authenticationExtensionsService: IAuthenticationExtensionsService,
		@IViewsService private readonly viewsService: IViewsService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
		@IProgressService private readonly progressService: IProgressService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IActivityService private readonly activityService: IActivityService,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceTrustRequestService private readonly workspaceTrustRequestService: IWorkspaceTrustRequestService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.context.onDidChange(() => this._onDidChange.fire()));
	}

	private setStep(step: ChatSetupStep): void {
		if (this._step === step) {
			return;
		}

		this._step = step;
		this._onDidChange.fire();
	}

	async setup(): Promise<void> {
		const title = localize('setupChatProgress', "Getting Copilot ready...");
		const badge = this.activityService.showViewContainerActivity(isCopilotEditsViewActive(this.viewsService) ? CHAT_EDITING_SIDEBAR_PANEL_ID : CHAT_SIDEBAR_PANEL_ID, {
			badge: new ProgressBadge(() => title),
		});

		try {
			await this.progressService.withProgress({
				location: ProgressLocation.Window,
				command: TRIGGER_SETUP_COMMAND_ID,
				title,
			}, () => this.doSetup());
		} finally {
			badge.dispose();
		}
	}

	private async doSetup(): Promise<void> {
		this.context.suspend();  // reduces flicker

		let focusChatInput = false;
		try {
			let session: AuthenticationSession | undefined;
			let entitlement: ChatEntitlement | undefined;

			// Entitlement Unknown: we need to sign-in user
			if (this.context.state.entitlement === ChatEntitlement.Unknown) {
				this.setStep(ChatSetupStep.SigningIn);
				const result = await this.signIn();
				if (!result.session) {
					this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotSignedIn', signUpErrorCode: undefined });
					return;
				}

				session = result.session;
				entitlement = result.entitlement;
			}

			const trusted = await this.workspaceTrustRequestService.requestWorkspaceTrust({
				message: localize('copilotWorkspaceTrust', "Copilot is currently only supported in trusted workspaces.")
			});
			if (!trusted) {
				this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNotTrusted', signUpErrorCode: undefined });
				return;
			}

			const activeElement = getActiveElement();

			// Install
			this.setStep(ChatSetupStep.Installing);
			await this.install(session, entitlement ?? this.context.state.entitlement);

			const currentActiveElement = getActiveElement();
			focusChatInput = activeElement === currentActiveElement || currentActiveElement === mainWindow.document.body;
		} finally {
			this.setStep(ChatSetupStep.Initial);
			this.context.resume();
		}

		if (focusChatInput) {
			(await showCopilotView(this.viewsService, this.layoutService))?.focusInput();
		}
	}

	private async signIn(): Promise<{ session: AuthenticationSession | undefined; entitlement: ChatEntitlement | undefined }> {
		let session: AuthenticationSession | undefined;
		let entitlement: ChatEntitlement | undefined;
		try {
			showCopilotView(this.viewsService, this.layoutService);

			session = await this.authenticationService.createSession(defaultChat.providerIds[0], defaultChat.providerScopes[0]);

			this.authenticationExtensionsService.updateAccountPreference(defaultChat.extensionId, defaultChat.providerIds[0], session.account);
			this.authenticationExtensionsService.updateAccountPreference(defaultChat.chatExtensionId, defaultChat.providerIds[0], session.account);

			entitlement = await this.requests.forceResolveEntitlement(session);
		} catch (e) {
			this.logService.error(`[chat setup] signIn: error ${e}`);
		}

		if (!session) {
			const { confirmed } = await this.dialogService.confirm({
				type: Severity.Error,
				message: localize('unknownSignInError', "Signing in to Copilot was unsuccessful. Would you like to try again?"),
				primaryButton: localize('retry', "Retry")
			});

			if (confirmed) {
				return this.signIn();
			}
		}

		return { session, entitlement };
	}

	private async install(session: AuthenticationSession | undefined, entitlement: ChatEntitlement,): Promise<void> {
		const wasInstalled = this.context.state.installed;
		let signUpResult: boolean | { errorCode: number } | undefined = undefined;

		try {
			showCopilotView(this.viewsService, this.layoutService);

			if (entitlement !== ChatEntitlement.Limited && entitlement !== ChatEntitlement.Pro && entitlement !== ChatEntitlement.Unavailable) {
				if (!session) {
					try {
						session = (await this.authenticationService.getSessions(defaultChat.providerIds[0])).at(0);
					} catch (error) {
						// ignore - errors can throw if a provider is not registered
					}

					if (!session) {
						this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedNoSession', signUpErrorCode: undefined });
						return; // unexpected
					}
				}

				signUpResult = await this.requests.signUpLimited(session);

				if (typeof signUpResult !== 'boolean' /* error */) {
					this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'failedSignUp', signUpErrorCode: signUpResult.errorCode });
				}
			}

			await this.doInstall();
		} catch (error) {
			this.logService.error(`[chat setup] install: error ${error}`);
			this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: isCancellationError(error) ? 'cancelled' : 'failedInstall', signUpErrorCode: undefined });
			return;
		}

		this.telemetryService.publicLog2<InstallChatEvent, InstallChatClassification>('commandCenter.chatInstall', { installResult: 'installed', signUpErrorCode: undefined });

		if (wasInstalled && signUpResult === true) {
			refreshTokens(this.commandService);
		}

		await Promise.race([
			timeout(5000), 												// helps prevent flicker with sign-in welcome view
			Event.toPromise(this.chatAgentService.onDidChangeAgents)	// https://github.com/microsoft/vscode-copilot/issues/9274
		]);
	}

	private async doInstall(): Promise<void> {
		let error: Error | undefined;
		try {
			await this.extensionsWorkbenchService.install(defaultChat.extensionId, {
				enable: true,
				isApplicationScoped: true, 	// install into all profiles
				isMachineScoped: false,		// do not ask to sync
				installEverywhere: true,	// install in local and remote
				installPreReleaseVersion: this.productService.quality !== 'stable'
			}, isCopilotEditsViewActive(this.viewsService) ? EditsViewId : ChatViewId);
		} catch (e) {
			this.logService.error(`[chat setup] install: error ${error}`);
			error = e;
		}

		if (error) {
			const { confirmed } = await this.dialogService.confirm({
				type: Severity.Error,
				message: localize('unknownSetupError', "An error occurred while setting up Copilot. Would you like to try again?"),
				detail: error && !isCancellationError(error) ? toErrorMessage(error) : undefined,
				primaryButton: localize('retry', "Retry")
			});

			if (confirmed) {
				return this.doInstall();
			}

			throw error;
		}
	}
}

class ChatSetupWelcomeContent extends Disposable {

	readonly element = $('.chat-setup-view');

	constructor(
		private readonly controller: ChatSetupController,
		private readonly context: ChatSetupContext,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();

		this.create();
	}

	private create(): void {
		const markdown = this.instantiationService.createInstance(MarkdownRenderer, {});

		// Header
		{
			const header = localize({ key: 'header', comment: ['{Locked="[Copilot]({0})"}'] }, "[Copilot]({0}) is your AI pair programmer.", this.context.state.installed ? 'command:github.copilot.open.walkthrough' : defaultChat.documentationUrl);
			this.element.appendChild($('p')).appendChild(this._register(markdown.render(new MarkdownString(header, { isTrusted: true }))).element);

			const featuresParent = this.element.appendChild($('div.chat-features-container'));
			this.element.appendChild(featuresParent);

			const featuresContainer = this.element.appendChild($('div'));
			featuresParent.appendChild(featuresContainer);

			const featureChatContainer = featuresContainer.appendChild($('div.chat-feature-container'));
			featureChatContainer.appendChild(renderIcon(Codicon.code));

			const featureChatLabel = featureChatContainer.appendChild($('span'));
			featureChatLabel.textContent = localize('featureChat', "Code faster with Completions");

			const featureEditsContainer = featuresContainer.appendChild($('div.chat-feature-container'));
			featureEditsContainer.appendChild(renderIcon(Codicon.editSession));

			const featureEditsLabel = featureEditsContainer.appendChild($('span'));
			featureEditsLabel.textContent = localize('featureEdits', "Build features with Copilot Edits");

			const featureExploreContainer = featuresContainer.appendChild($('div.chat-feature-container'));
			featureExploreContainer.appendChild(renderIcon(Codicon.commentDiscussion));

			const featureExploreLabel = featureExploreContainer.appendChild($('span'));
			featureExploreLabel.textContent = localize('featureExplore', "Explore your codebase with Chat");
		}

		// Limited SKU
		const free = localize({ key: 'free', comment: ['{Locked="[]({0})"}'] }, "$(sparkle-filled) We now offer [Copilot for free]({0}).", defaultChat.skusDocumentationUrl);
		const freeContainer = this.element.appendChild($('p'));
		freeContainer.appendChild(this._register(markdown.render(new MarkdownString(free, { isTrusted: true, supportThemeIcons: true }))).element);

		// Setup Button
		const actions: IAction[] = [];
		if (this.context.state.installed) {
			actions.push(toAction({ id: 'chatSetup.signInGh', label: localize('signInGh', "Sign in with a GitHub.com Account"), run: () => this.commandService.executeCommand('github.copilotChat.signIn') }));
			actions.push(toAction({ id: 'chatSetup.signInGhe', label: localize('signInGhe', "Sign in with a GHE.com Account"), run: () => this.commandService.executeCommand('github.copilotChat.signInGHE') }));
		}
		const buttonContainer = this.element.appendChild($('p'));
		buttonContainer.classList.add('button-container');
		const button = this._register(actions.length === 0 ? new Button(buttonContainer, {
			supportIcons: true,
			...defaultButtonStyles
		}) : new ButtonWithDropdown(buttonContainer, {
			actions,
			addPrimaryActionToDropdown: false,
			contextMenuProvider: this.contextMenuService,
			supportIcons: true,
			...defaultButtonStyles
		}));
		this._register(button.onDidClick(() => this.controller.setup()));

		// Terms
		const terms = localize({ key: 'terms', comment: ['{Locked="["}', '{Locked="]({0})"}', '{Locked="]({1})"}'] }, "By continuing, you agree to the [Terms]({0}) and [Privacy Policy]({1}).", defaultChat.termsStatementUrl, defaultChat.privacyStatementUrl);
		this.element.appendChild($('p')).appendChild(this._register(markdown.render(new MarkdownString(terms, { isTrusted: true }))).element);

		// SKU Settings
		const settings = localize({ key: 'settings', comment: ['{Locked="["}', '{Locked="]({0})"}', '{Locked="]({1})"}'] }, "Copilot Free and Pro may show [public code]({0}) suggestions and we may use your data for product improvement. You can change these [settings]({1}) at any time.", defaultChat.publicCodeMatchesUrl, defaultChat.manageSettingsUrl);
		const settingsContainer = this.element.appendChild($('p'));
		settingsContainer.appendChild(this._register(markdown.render(new MarkdownString(settings, { isTrusted: true }))).element);

		// Update based on model state
		this._register(Event.runAndSubscribe(this.controller.onDidChange, () => this.update(freeContainer, settingsContainer, button)));
	}

	private update(freeContainer: HTMLElement, settingsContainer: HTMLElement, button: Button | ButtonWithDropdown): void {
		const showSettings = this.telemetryService.telemetryLevel !== TelemetryLevel.NONE;
		let showFree: boolean;
		let buttonLabel: string;

		switch (this.context.state.entitlement) {
			case ChatEntitlement.Unknown:
				showFree = true;
				buttonLabel = this.context.state.registered ? localize('signUp', "Sign in to Use Copilot") : localize('signUpFree', "Sign in to Use Copilot for Free");
				break;
			case ChatEntitlement.Unresolved:
				showFree = true;
				buttonLabel = this.context.state.registered ? localize('startUp', "Use Copilot") : localize('startUpLimited', "Use Copilot for Free");
				break;
			case ChatEntitlement.Available:
			case ChatEntitlement.Limited:
				showFree = true;
				buttonLabel = localize('startUpLimited', "Use Copilot for Free");
				break;
			case ChatEntitlement.Pro:
			case ChatEntitlement.Unavailable:
				showFree = false;
				buttonLabel = localize('startUp', "Use Copilot");
				break;
		}

		switch (this.controller.step) {
			case ChatSetupStep.SigningIn:
				buttonLabel = localize('setupChatSignIn', "$(loading~spin) Signing in to {0}...", defaultChat.providerName);
				break;
			case ChatSetupStep.Installing:
				buttonLabel = localize('setupChatInstalling', "$(loading~spin) Getting Copilot Ready...");
				break;
		}

		setVisibility(showFree, freeContainer);
		setVisibility(showSettings, settingsContainer);

		button.label = buttonLabel;
		button.enabled = this.controller.step === ChatSetupStep.Initial;
	}
}

//#endregion

//#region Context

interface IChatSetupContextState {
	entitlement: ChatEntitlement;
	hidden?: boolean;
	installed?: boolean;
	registered?: boolean;
}

class ChatSetupContext extends Disposable {

	private static readonly CHAT_SETUP_CONTEXT_STORAGE_KEY = 'chat.setupContext';

	private readonly canSignUpContextKey = ChatContextKeys.Setup.canSignUp.bindTo(this.contextKeyService);
	private readonly signedOutContextKey = ChatContextKeys.Setup.signedOut.bindTo(this.contextKeyService);
	private readonly limitedContextKey = ChatContextKeys.Setup.limited.bindTo(this.contextKeyService);
	private readonly proContextKey = ChatContextKeys.Setup.pro.bindTo(this.contextKeyService);
	private readonly hiddenContext = ChatContextKeys.Setup.hidden.bindTo(this.contextKeyService);
	private readonly installedContext = ChatContextKeys.Setup.installed.bindTo(this.contextKeyService);

	private _state: IChatSetupContextState = this.storageService.getObject<IChatSetupContextState>(ChatSetupContext.CHAT_SETUP_CONTEXT_STORAGE_KEY, StorageScope.PROFILE) ?? { entitlement: ChatEntitlement.Unknown };
	private suspendedState: IChatSetupContextState | undefined = undefined;
	get state(): IChatSetupContextState {
		return this.suspendedState ?? this._state;
	}

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private updateBarrier: Barrier | undefined = undefined;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkbenchExtensionEnablementService private readonly extensionEnablementService: IWorkbenchExtensionEnablementService,
		@ILogService private readonly logService: ILogService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
	) {
		super();

		this.checkExtensionInstallation();
		this.updateContextSync();
	}

	private async checkExtensionInstallation(): Promise<void> {

		// Await extensions to be ready to be queries
		await this.extensionsWorkbenchService.queryLocal();

		// Listen to change and process extensions once
		this._register(Event.runAndSubscribe(this.extensionsWorkbenchService.onChange, (e) => {
			if (e && !ExtensionIdentifier.equals(e.identifier.id, defaultChat.extensionId)) {
				return; // unrelated event
			}

			const defaultChatExtension = this.extensionsWorkbenchService.local.find(value => ExtensionIdentifier.equals(value.identifier.id, defaultChat.extensionId));
			this.update({ installed: !!defaultChatExtension?.local && this.extensionEnablementService.isEnabled(defaultChatExtension.local) });
		}));
	}

	update(context: { installed: boolean }): Promise<void>;
	update(context: { hidden: boolean }): Promise<void>;
	update(context: { entitlement: ChatEntitlement }): Promise<void>;
	update(context: { installed?: boolean; hidden?: boolean; entitlement?: ChatEntitlement }): Promise<void> {
		this.logService.trace(`[chat setup] update(): ${JSON.stringify(context)}`);

		if (typeof context.installed === 'boolean') {
			this._state.installed = context.installed;

			if (context.installed) {
				context.hidden = false; // allows to fallback to setup view if the extension is uninstalled
			}
		}

		if (typeof context.hidden === 'boolean') {
			this._state.hidden = context.hidden;
		}

		if (typeof context.entitlement === 'number') {
			this._state.entitlement = context.entitlement;

			if (this._state.entitlement === ChatEntitlement.Limited || this._state.entitlement === ChatEntitlement.Pro) {
				this._state.registered = true; // remember that the user did register to improve setup screen
			} else if (this._state.entitlement === ChatEntitlement.Available) {
				this._state.registered = false; // only restore when signed-in user can sign-up for limited
			}
		}

		this.storageService.store(ChatSetupContext.CHAT_SETUP_CONTEXT_STORAGE_KEY, this._state, StorageScope.PROFILE, StorageTarget.MACHINE);

		return this.updateContext();
	}

	private async updateContext(): Promise<void> {
		await this.updateBarrier?.wait();

		this.updateContextSync();
	}

	private updateContextSync(): void {
		this.logService.trace(`[chat setup] updateContext(): ${JSON.stringify(this._state)}`);

		if (!this._state.hidden && !this._state.installed) {
			// this is ugly but fixes flicker from a previous chat install
			this.storageService.remove('chat.welcomeMessageContent.panel', StorageScope.APPLICATION);
			this.storageService.remove('interactive.sessions', this.workspaceContextService.getWorkspace().folders.length ? StorageScope.WORKSPACE : StorageScope.APPLICATION);
		}

		this.signedOutContextKey.set(this._state.entitlement === ChatEntitlement.Unknown);
		this.canSignUpContextKey.set(this._state.entitlement === ChatEntitlement.Available);
		this.limitedContextKey.set(this._state.entitlement === ChatEntitlement.Limited);
		this.proContextKey.set(this._state.entitlement === ChatEntitlement.Pro);
		this.hiddenContext.set(!!this._state.hidden);
		this.installedContext.set(!!this._state.installed);

		this._onDidChange.fire();
	}

	suspend(): void {
		this.suspendedState = { ...this._state };
		this.updateBarrier = new Barrier();
	}

	resume(): void {
		this.suspendedState = undefined;
		this.updateBarrier?.open();
		this.updateBarrier = undefined;
	}
}

//#endregion

function isCopilotEditsViewActive(viewsService: IViewsService): boolean {
	return viewsService.getFocusedView()?.id === EditsViewId;
}

function showCopilotView(viewsService: IViewsService, layoutService: IWorkbenchLayoutService): Promise<IChatWidget | undefined> {

	// Ensure main window is in front
	if (layoutService.activeContainer !== layoutService.mainContainer) {
		layoutService.mainContainer.focus();
	}

	// Bring up the correct view
	if (isCopilotEditsViewActive(viewsService)) {
		return showEditsView(viewsService);
	} else {
		return showChatView(viewsService);
	}
}

function refreshTokens(commandService: ICommandService): void {
	// ugly, but we need to signal to the extension that entitlements changed
	commandService.executeCommand('github.copilot.signIn');
	commandService.executeCommand('github.copilot.refreshToken');
}
