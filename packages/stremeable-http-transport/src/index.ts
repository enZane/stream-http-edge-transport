import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
	type JSONRPCMessage,
	JSONRPCMessageSchema,
	type RequestId,
	isInitializeRequest,
	isJSONRPCError,
	isJSONRPCRequest,
	isJSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js"

const MAXIMUM_MESSAGE_SIZE = 4 * 1024 * 1024 // 4MB in bytes

export type StreamId = string
export type EventId = string

/**
 * Auth info interface for edge compatibility
 */
export interface AuthInfo {
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	[key: string]: any
}

/**
 * Interface for resumability support via event storage
 */
export interface EventStore {
	/**
	 * Stores an event for later retrieval
	 * @param streamId ID of the stream the event belongs to
	 * @param message The JSON-RPC message to store
	 * @returns The generated event ID for the stored event
	 */
	storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>

	replayEventsAfter(
		lastEventId: EventId,
		{
			send,
		}: {
			send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>
		}
	): Promise<StreamId>
}

/**
 * Configuration options for EdgeStreamableHTTPTransport
 */
export interface EdgeStreamableHTTPTransportOptions {
	/**
	 * Function that generates a session ID for the transport.
	 * The session ID SHOULD be globally unique and cryptographically secure (e.g., a securely generated UUID, a JWT, or a cryptographic hash)
	 *
	 * Return undefined to disable session management.
	 */
	sessionIdGenerator: (() => string) | undefined

	/**
	 * A callback for session initialization events
	 * This is called when the server initializes a new session.
	 * Useful in cases when you need to register multiple mcp sessions
	 * and need to keep track of them.
	 * @param sessionId The generated session ID
	 */
	onsessioninitialized?: (sessionId: string) => void

	/**
	 * If true, the server will return JSON responses instead of starting an SSE stream.
	 * This can be useful for simple request/response scenarios without streaming.
	 * Default is false (SSE streams are preferred).
	 */
	enableJsonResponse?: boolean

	/**
	 * Event store for resumability support
	 * If provided, resumability will be enabled, allowing clients to reconnect and resume messages
	 */
	eventStore?: EventStore
}

/**
 * Edge-compatible server transport for Streamable HTTP: this implements the MCP Streamable HTTP transport specification.
 * It supports both SSE streaming and direct HTTP responses using Web Fetch API.
 *
 * Usage example with Hono:
 *
 * ```typescript
 * import { Hono } from 'hono';
 * import { EdgeStreamableHTTPTransport } from './edge-transport';
 *
 * const app = new Hono();
 * const transport = new EdgeStreamableHTTPTransport({
 *   sessionIdGenerator: () => crypto.randomUUID(),
 * });
 *
 * app.all('/mcp', async (c) => {
 *   return await transport.handleRequest(c.req.raw);
 * });
 * ```
 *
 * In stateful mode:
 * - Session ID is generated and included in response headers
 * - Session ID is always included in initialization responses
 * - Requests with invalid session IDs are rejected with 404 Not Found
 * - Non-initialization requests without a session ID are rejected with 400 Bad Request
 * - State is maintained in-memory (connections, message history)
 *
 * In stateless mode:
 * - No Session ID is included in any responses
 * - No session validation is performed
 */
export class EdgeStreamableHTTPTransport implements Transport {
	// when sessionId is not set (undefined), it means the transport is in stateless mode
	private sessionIdGenerator: (() => string) | undefined
	private _started = false
	private _streamMapping: Map<string, ReadableStreamDefaultController> = new Map()
	private _requestToStreamMapping: Map<RequestId, string> = new Map()
	private _requestResponseMap: Map<RequestId, JSONRPCMessage> = new Map()
	private _initialized = false
	private _enableJsonResponse = false
	private _standaloneSseStreamId = "_GET_stream"
	private _eventStore?: EventStore
	private _onsessioninitialized?: (sessionId: string) => void
	private _pendingResponses: Map<string, Response> = new Map()

	sessionId?: string | undefined
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: (message: JSONRPCMessage, extra?: { authInfo?: AuthInfo }) => void

	constructor(options: EdgeStreamableHTTPTransportOptions) {
		this.sessionIdGenerator = options.sessionIdGenerator
		this._enableJsonResponse = options.enableJsonResponse ?? false
		this._eventStore = options.eventStore
		this._onsessioninitialized = options.onsessioninitialized
	}

	/**
	 * Starts the transport. This is required by the Transport interface but is a no-op
	 * for the Streamable HTTP transport as connections are managed per-request.
	 */
	async start(): Promise<void> {
		if (this._started) {
			throw new Error("Transport already started")
		}
		this._started = true
	}

	/**
	 * Handles an incoming HTTP request using Web Fetch API
	 */
	async handleRequest(request: Request, body: string, authInfo?: AuthInfo): Promise<Response> {
		const method = request.method

		if (method === "POST") {
			return await this.handlePostRequest(request, body, authInfo)
		}
		if (method === "GET") {
			return await this.handleGetRequest(request)
		}
		if (method === "DELETE") {
			return await this.handleDeleteRequest(request)
		}
		return this.handleUnsupportedRequest()
	}

	/**
	 * Handles GET requests for SSE stream
	 */
	private async handleGetRequest(request: Request): Promise<Response> {
		// The client MUST include an Accept header, listing text/event-stream as a supported content type.
		const acceptHeader = request.headers.get("accept")
		if (!acceptHeader?.includes("text/event-stream")) {
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Not Acceptable: Client must accept text/event-stream",
					},
					id: null,
				}),
				{
					status: 406,
					headers: { "Content-Type": "application/json" },
				}
			)
		}

		// Validate session
		const validationResponse = this.validateSession(request)
		if (validationResponse) {
			return validationResponse
		}

		// Handle resumability: check for Last-Event-ID header
		if (this._eventStore) {
			const lastEventId = request.headers.get("last-event-id")
			if (lastEventId) {
				return await this.replayEvents(lastEventId)
			}
		}

		// Check if there's already an active standalone SSE stream for this session
		if (this._streamMapping.get(this._standaloneSseStreamId) !== undefined) {
			// Only one GET SSE stream is allowed per session
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Conflict: Only one SSE stream is allowed per session",
					},
					id: null,
				}),
				{
					status: 409,
					headers: { "Content-Type": "application/json" },
				}
			)
		}

		// Create SSE stream
		const { readable, controller } = this.createSSEStream()

		// Store the controller for this stream
		this._streamMapping.set(this._standaloneSseStreamId, controller)

		const headers: Record<string, string> = {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		}

		// After initialization, always include the session ID if we have one
		if (this.sessionId !== undefined) {
			headers["mcp-session-id"] = this.sessionId
		}

		return new Response(readable, { headers })
	}

	/**
	 * Creates a Server-Sent Events stream using ReadableStream
	 */
	private createSSEStream(): {
		readable: ReadableStream
		controller: ReadableStreamDefaultController
	} {
		let controller: ReadableStreamDefaultController

		const self = this
		const readable = new ReadableStream({
			start(ctrl) {
				controller = ctrl
			},
			cancel() {
				self._streamMapping.delete(self._standaloneSseStreamId)
			},
		})

		// biome-ignore lint/style/noNonNullAssertion: <explanation>
		return { readable, controller: controller! }
	}

	/**
	 * Replays events that would have been sent after the specified event ID
	 * Only used when resumability is enabled
	 */
	private async replayEvents(lastEventId: string): Promise<Response> {
		if (!this._eventStore) {
			return new Response("", { status: 400 })
		}

		try {
			const { readable, controller } = this.createSSEStream()

			const headers: Record<string, string> = {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
			}

			if (this.sessionId !== undefined) {
				headers["mcp-session-id"] = this.sessionId
			}

			const streamId = await this._eventStore.replayEventsAfter(lastEventId, {
				send: async (eventId: string, message: JSONRPCMessage) => {
					this.writeSSEEvent(controller, message, eventId)
				},
			})

			this._streamMapping.set(streamId, controller)

			return new Response(readable, { headers })
		} catch (error) {
			this.onerror?.(error as Error)
			return new Response("Internal Server Error", { status: 500 })
		}
	}

	/**
	 * Writes an event to the SSE stream with proper formatting
	 */
	private writeSSEEvent(controller: ReadableStreamDefaultController, message: JSONRPCMessage, eventId?: string): void {
		let eventData = "event: message\n"
		// Include event ID if provided - this is important for resumability
		if (eventId) {
			eventData += `id: ${eventId}\n`
		}
		eventData += `data: ${JSON.stringify(message)}\n\n`

		try {
			controller.enqueue(new TextEncoder().encode(eventData))
		} catch (error) {
			this.onerror?.(error as Error)
		}
	}

	/**
	 * Handles unsupported requests (PUT, PATCH, etc.)
	 */
	private handleUnsupportedRequest(): Response {
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message: "Method not allowed.",
				},
				id: null,
			}),
			{
				status: 405,
				headers: {
					Allow: "GET, POST, DELETE",
					"Content-Type": "application/json",
				},
			}
		)
	}

	/**
	 * Generates a random UUID using Web Crypto API
	 */
	private generateUUID(): string {
		return crypto.randomUUID()
	}

	/**
	 * Handles POST requests containing JSON-RPC messages
	 */
	private async handlePostRequest(request: Request, body: string, authInfo?: AuthInfo): Promise<Response> {
		try {
			// Validate the Accept header
			const acceptHeader = request.headers.get("accept")
			// The client MUST include an Accept header, listing both application/json and text/event-stream as supported content types.
			if (!acceptHeader?.includes("application/json") || !acceptHeader.includes("text/event-stream")) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Not Acceptable: Client must accept both application/json and text/event-stream",
						},
						id: null,
					}),
					{
						status: 406,
						headers: { "Content-Type": "application/json" },
					}
				)
			}

			const contentType = request.headers.get("content-type")
			if (!contentType || !contentType.includes("application/json")) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Unsupported Media Type: Content-Type must be application/json",
						},
						id: null,
					}),
					{
						status: 415,
						headers: { "Content-Type": "application/json" },
					}
				)
			}

			// Read and parse body
			const bodyText = body
			if (bodyText.length > MAXIMUM_MESSAGE_SIZE) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Request too large",
						},
						id: null,
					}),
					{
						status: 413,
						headers: { "Content-Type": "application/json" },
					}
				)
			}

			const rawMessage = JSON.parse(bodyText)
			let messages: JSONRPCMessage[]

			// handle batch and single messages
			if (Array.isArray(rawMessage)) {
				messages = rawMessage.map((msg) => JSONRPCMessageSchema.parse(msg))
			} else {
				messages = [JSONRPCMessageSchema.parse(rawMessage)]
			}

			// Check if this is an initialization request
			const isInitializationRequest = messages.some(isInitializeRequest)
			if (isInitializationRequest) {
				// If it's a server with session management and the session ID is already set we should reject the request
				// to avoid re-initialization.
				if (this._initialized && this.sessionId !== undefined) {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							error: {
								code: -32600,
								message: "Invalid Request: Server already initialized",
							},
							id: null,
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json" },
						}
					)
				}
				if (messages.length > 1) {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							error: {
								code: -32600,
								message: "Invalid Request: Only one initialization request is allowed",
							},
							id: null,
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json" },
						}
					)
				}
				this.sessionId = this.sessionIdGenerator?.()
				this._initialized = true

				// If we have a session ID and an onsessioninitialized handler, call it immediately
				if (this.sessionId && this._onsessioninitialized) {
					this._onsessioninitialized(this.sessionId)
				}
			}

			// Validate session for non-initialization requests
			if (!isInitializationRequest) {
				const validationResponse = this.validateSession(request)
				if (validationResponse) {
					return validationResponse
				}
			}

			// check if it contains requests
			const hasRequests = messages.some(isJSONRPCRequest)

			if (!hasRequests) {
				// if it only contains notifications or responses, return 202
				// handle each message
				for (const message of messages) {
					this.onmessage?.(message, { authInfo })
				}
				return new Response("", { status: 202 })
			}
			if (hasRequests) {
				// The default behavior is to use SSE streaming
				// but in some cases server will return JSON responses
				const streamId = this.generateUUID()

				if (!this._enableJsonResponse) {
					// Create SSE stream for responses
					const { readable, controller } = this.createSSEStream()
					this._streamMapping.set(streamId, controller)

					// Store the response mapping
					for (const message of messages) {
						if (isJSONRPCRequest(message)) {
							this._requestToStreamMapping.set(message.id, streamId)
						}
					}

					const headers: Record<string, string> = {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					}

					// After initialization, always include the session ID if we have one
					if (this.sessionId !== undefined) {
						headers["mcp-session-id"] = this.sessionId
					}

					// Process messages asynchronously
					setTimeout(() => {
						for (const message of messages) {
							this.onmessage?.(message, { authInfo })
						}
					}, 0)

					return new Response(readable, { headers })
				}
				// JSON response mode - store request mappings and return a promise that resolves when all responses are ready
				for (const message of messages) {
					if (isJSONRPCRequest(message)) {
						this._requestToStreamMapping.set(message.id, streamId)
					}
				}

				// Create a promise that resolves when all responses are ready
				const responsePromise = new Promise<Response>((resolve) => {
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					this._pendingResponses.set(streamId, resolve as any)
				})

				// Process messages asynchronously
				setTimeout(() => {
					for (const message of messages) {
						this.onmessage?.(message, { authInfo })
					}
				}, 0)

				return responsePromise
			}

			return new Response("", { status: 200 })
		} catch (error) {
			// return JSON-RPC formatted error
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32700,
						message: "Parse error",
						data: String(error),
					},
					id: null,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				}
			)
		}
	}

	/**
	 * Handles DELETE requests to terminate sessions
	 */
	private async handleDeleteRequest(request: Request): Promise<Response> {
		const validationResponse = this.validateSession(request)
		if (validationResponse) {
			return validationResponse
		}

		await this.close()
		return new Response("", { status: 200 })
	}

	/**
	 * Validates session ID for non-initialization requests
	 * Returns a Response if the session is invalid, null if valid
	 */
	private validateSession(request: Request): Response | null {
		if (this.sessionIdGenerator === undefined) {
			// If the sessionIdGenerator ID is not set, the session management is disabled
			// and we don't need to validate the session ID
			return null
		}

		if (!this._initialized) {
			// If the server has not been initialized yet, reject all requests
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Bad Request: Server not initialized",
					},
					id: null,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				}
			)
		}

		const sessionId = request.headers.get("mcp-session-id")

		if (!sessionId) {
			// Non-initialization requests without a session ID should return 400 Bad Request
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message: "Bad Request: Mcp-Session-Id header is required",
					},
					id: null,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				}
			)
		}
		if (sessionId !== this.sessionId) {
			// Reject requests with invalid session ID with 404 Not Found
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32001,
						message: "Session not found",
					},
					id: null,
				}),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				}
			)
		}

		return null
	}

	async close(): Promise<void> {
		// Close all SSE streams
		this._streamMapping.forEach((controller) => {
			try {
				controller.close()
			} catch (_error) {
				// Controller might already be closed
			}
		})
		this._streamMapping.clear()

		// Clear any pending responses
		this._requestResponseMap.clear()
		this._pendingResponses.clear()
		this.onclose?.()
	}

	async send(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void> {
		let requestId = options?.relatedRequestId
		if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
			// If the message is a response, use the request ID from the message
			requestId = message.id
		}

		// Check if this message should be sent on the standalone SSE stream (no request ID)
		if (requestId === undefined) {
			// For standalone SSE streams, we can only send requests and notifications
			if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
				throw new Error("Cannot send a response on a standalone SSE stream unless resuming a previous client request")
			}

			const standaloneController = this._streamMapping.get(this._standaloneSseStreamId)
			if (standaloneController === undefined) {
				// The spec says the server MAY send messages on the stream, so it's ok to discard if no stream
				return
			}

			// Generate and store event ID if event store is provided
			let eventId: string | undefined
			if (this._eventStore) {
				eventId = await this._eventStore.storeEvent(this._standaloneSseStreamId, message)
			}

			// Send the message to the standalone SSE stream
			this.writeSSEEvent(standaloneController, message, eventId)
			return
		}

		// Get the stream for this request
		const streamId = this._requestToStreamMapping.get(requestId)
		if (!streamId) {
			throw new Error(`No stream found for request ID: ${String(requestId)}`)
		}
		const controller = this._streamMapping.get(streamId)

		if (!streamId) {
			throw new Error(`No connection established for request ID: ${String(requestId)}`)
		}

		if (!this._enableJsonResponse && controller) {
			// For SSE responses, generate event ID if event store is provided
			let eventId: string | undefined
			if (this._eventStore) {
				eventId = await this._eventStore.storeEvent(streamId, message)
			}

			// Write the event to the response stream
			this.writeSSEEvent(controller, message, eventId)
		}

		if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
			this._requestResponseMap.set(requestId, message)

			// Get all request IDs for this stream
			const relatedIds = Array.from(this._requestToStreamMapping.entries())
				.filter(([_, sid]) => sid === streamId)
				.map(([id]) => id)

			// Check if we have responses for all requests using this connection
			const allResponsesReady = relatedIds.every((id) => this._requestResponseMap.has(id))

			if (allResponsesReady) {
				if (this._enableJsonResponse) {
					// Resolve the pending response promise
					const pendingResponse = this._pendingResponses.get(streamId)
					if (pendingResponse) {
						const headers: Record<string, string> = {
							"Content-Type": "application/json",
						}
						if (this.sessionId !== undefined) {
							headers["mcp-session-id"] = this.sessionId
						}

						const responses = relatedIds.map((id) => this._requestResponseMap.get(id))
						const response = new Response(JSON.stringify(responses.length === 1 ? responses[0] : responses), {
							status: 200,
							headers,
						})
						// biome-ignore lint/suspicious/noExplicitAny: <explanation>
						;(pendingResponse as any)(response)
						this._pendingResponses.delete(streamId)
					}
				} else if (controller) {
					// End the SSE stream
					try {
						controller.close()
					} catch (_error) {
						// Controller might already be closed
					}
				}

				// Clean up
				for (const id of relatedIds) {
					this._requestResponseMap.delete(id)
					this._requestToStreamMapping.delete(id)
				}
				this._streamMapping.delete(streamId)
			}
		}
	}
}
