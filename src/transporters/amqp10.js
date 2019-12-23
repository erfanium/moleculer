/*
 * moleculer
 * Copyright (c) 2019 MoleculerJS (https://github.com/moleculerjs/moleculer)
 * MIT Licensed
 */

"use strict";

const url = require("url");
const Promise = require("bluebird");
const Transporter = require("./base");
const { isPromise } = require("../utils");

const {
	PACKET_REQUEST,
	PACKET_RESPONSE,
	PACKET_UNKNOWN,
	PACKET_EVENT,
	PACKET_DISCOVER,
	PACKET_INFO,
	PACKET_DISCONNECT,
	PACKET_HEARTBEAT,
	PACKET_PING,
	PACKET_PONG
} = require("../packets");

/**
 * Transporter for AMQP 1.0
 *
 * More info: https://www.amqp.org/resources/specifications
 *
 * @class Amqp10Transporter
 * @extends {Transporter}
 */
class Amqp10Transporter extends Transporter {
	/**
	 * Creates an instance of Amqp10Transporter.
	 *
	 * @param {any} opts
	 *
	 * @memberof Amqp10Transporter
	 */
	constructor(opts) {
		if (typeof opts == "string") opts = { url: opts };

		super(opts);

		/* istanbul ignore next*/
		if (!this.opts) this.opts = {};

		// Number of requests a broker will handle concurrently
		if (typeof opts.prefetch !== "number") opts.prefetch = 1;

		// Number of milliseconds before an event expires
		if (typeof opts.eventTimeToLive !== "number") opts.eventTimeToLive = null;

		if (typeof opts.heartbeatTimeToLive !== "number") opts.heartbeatTimeToLive = null;

		if (typeof opts.queueOptions !== "object") opts.queueOptions = {};

		if (typeof opts.topicOptions !== "object") opts.topicOptions = {};

		if (typeof opts.messageOptions !== "object") opts.messageOptions = {};

		if (typeof opts.topicPrefix !== "string") opts.topicPrefix = "topic://";

		this.receivers = [];
		this.hasBuiltInBalancer = true;
		this.connection = null;
	}

	_getQueueOptions(packetType, balancedQueue) {
		let packetOptions = {};
		switch (packetType) {
			// Requests and responses don't expire.
			case PACKET_REQUEST:
				// TODO: auto delete
				break;
			case PACKET_RESPONSE:
				// TODO: auto delete
				break;

			// Consumers can decide how long events live
			// Load-balanced/grouped events
			case PACKET_EVENT + "LB":
			case PACKET_EVENT:
				// TODO: auto delete
				break;

			// Packet types meant for internal use
			case PACKET_HEARTBEAT:
				// TODO: auto delete
				// packetOptions = {};
				break;
			case PACKET_DISCOVER:
			case PACKET_DISCONNECT:
			case PACKET_UNKNOWN:
			case PACKET_INFO:
			case PACKET_PING:
			case PACKET_PONG:
				// TODO: auto delete
				break;
		}

		return Object.assign(packetOptions, this.opts.queueOptions);
	}

	_getMessageOptions(packetType) {
		let messageOptions = {};
		switch (packetType) {
			case PACKET_REQUEST:
			case PACKET_RESPONSE:
				break;
			case PACKET_EVENT + "LB":
			case PACKET_EVENT:
				if (this.opts.eventTimeToLive) messageOptions.ttl = this.opts.eventTimeToLive;
				break;
			case PACKET_HEARTBEAT:
				if (this.opts.heartbeatTimeToLive) messageOptions.ttl = this.opts.heartbeatTimeToLive;
				break;
			case PACKET_DISCOVER:
			case PACKET_DISCONNECT:
			case PACKET_UNKNOWN:
			case PACKET_INFO:
			case PACKET_PING:
			case PACKET_PONG:
				break;
		}

		return Object.assign(messageOptions, this.opts.messageOptions);
	}

	/**
	 * Build a function to handle requests.
	 *
	 * @param {String} cmd
	 * @param {Boolean} needAck
	 *
	 * @memberof Amqp10Transporter
	 */
	_consumeCB(cmd, needAck = false) {
		return async ({ message, delivery }) => {
			const result = this.incomingMessage(cmd, message.body);

			if (needAck) {
				if (isPromise(result)) {
					return result
						.then(() => {
							if (this.connection) {
								delivery.accept();
							}
						})
						.catch(err => {
							this.logger.error("Message handling error.", err);
							if (this.connection) {
								delivery.reject();
							}
						});
				} else {
					if (this.connection) {
						delivery.accept();
					}
				}
			}

			return result;
		};
	}

	/**
	 * Connect to a AMQP 1.0 server
	 *
	 * @memberof Amqp10Transporter
	 */
	async connect(errorCallback) {
		let rhea;

		try {
			rhea = require("rhea-promise");
		} catch (err) {
			/* istanbul ignore next */
			this.broker.fatal(
				"The 'rhea-promise' package is missing. Please install it with 'npm install rhea-promise --save' command.",
				err,
				true
			);
		}

		if (!rhea) {
			/* istanbul ignore next*/
			this.broker.fatal("Missing rhea package", new Error("Missing rhea package"), true);
		}

		// Pick url
		const uri = this.opts.url;
		const urlParsed = url.parse(uri);
		const username = urlParsed.auth ? urlParsed.auth.split(":")[0] : undefined;
		const password = urlParsed.auth ? urlParsed.auth.split(":")[1] : undefined;
		const connectionOptions = {
			host: urlParsed.hostname,
			hostname: urlParsed.hostname,
			username,
			password,
			port: urlParsed.port || 5672,
			container_id: rhea.generate_uuid()
		};
		const container = new rhea.Container();
		const connection = container.createConnection(connectionOptions);
		try {
			this.connection = await connection.open();
			this.logger.info("AMQP10 is connected");
			this.connection._connection.setMaxListeners(0);
			await this.onConnected();
		} catch (e) {
			this.logger.info("AMQP10 is disconnected.");
			this.connected = false;
			this.connection = null;
			this.logger.error(e);
			errorCallback && errorCallback(e);
		}
	}

	/**
	 * Disconnect from an AMQP 1.0 server
	 * Close every receiver on the connections and the close the connection
	 * @memberof Amqp10Transporter
	 */
	async disconnect() {
		try {
			if (this.connection) {
				for (const receiver of this.receivers) {
					await receiver.close();
				}
				await this.connection.close();
				this.connection = null;
				this.connected = false;
				this.receivers = [];
			}
		} catch (error) {
			this.logger.error(error);
		}
	}

	/**
	 * Subscribe to a command
	 *
	 * @param {String} cmd
	 * @param {String} nodeID
	 *
	 * @memberof Amqp10Transporter
	 * @description Initialize queues and topics for all packet types.
	 *
	 * All packets that should reach multiple nodes have a dedicated topic for that command
	 * These packet types will not use acknowledgements.
	 * The time-to-live for EVENT packets can be configured in options.
	 * Examples: INFO, DISCOVER, DISCONNECT, HEARTBEAT, PING, PONG, EVENT
	 *
	 * Other Packets are headed towards a specific queue. These don't need topics and
	 * packets of this type will not expire.
	 * Examples: REQUEST, RESPONSE
	 *
	 * RESPONSE: Each node has its own dedicated queue and acknowledgements will not be used.
	 *
	 * REQUEST: Each action has its own dedicated queue. This way if an action has multiple workers,
	 * they can all pull from the same queue. This allows a message to be retried by a different node
	 * if one dies before responding.
	 *
	 */
	async subscribe(cmd, nodeID) {
		if (!this.connection) return;

		const topic = this.getTopicName(cmd, nodeID);
		let receiverOptions = this._getQueueOptions(cmd);

		if (nodeID) {
			const needAck = [PACKET_REQUEST].indexOf(cmd) !== -1;
			Object.assign(receiverOptions, this.opts.queueOptions, {
				credit_window: 0,
				autoaccept: !needAck,
				name: topic,
				source: {
					address: topic
				}
			});

			const receiver = await this.connection.createReceiver(receiverOptions);
			receiver.addCredit(this.opts.prefetch);

			receiver.on("message", async context => {
				await this._consumeCB(cmd, needAck)(context);
				receiver.addCredit(1);
			});

			this.receivers.push(receiver);
		} else {
			const topicName = `${this.opts.topicPrefix}${topic}`;
			Object.assign(receiverOptions, this.opts.topicOptions, {
				name: topicName,
				source: {
					address: topicName
				}
			});
			const receiver = await this.connection.createReceiver(receiverOptions);

			receiver.on("message", context => {
				this._consumeCB(cmd, false)(context);
			});

			this.receivers.push(receiver);
		}
	}

	/**
	 * Subscribe to balanced action commands
	 * For REQB command types
	 * These queues will be used when the "disableBalancer" set to true
	 *
	 * @param {String} action
	 * @memberof Amqp10Transporter
	 */
	async subscribeBalancedRequest(action) {
		const queue = `${this.prefix}.${PACKET_REQUEST}B.${action}`;
		const receiverOptions = Object.assign(
			{
				credit_window: 0,
				source: { address: queue },
				autoaccept: false
			},
			this._getQueueOptions(PACKET_REQUEST, true)
		);
		const receiver = await this.connection.createReceiver(receiverOptions);
		receiver.addCredit(1);

		receiver.on("message", async context => {
			await this._consumeCB(PACKET_REQUEST, true)(context);
			receiver.addCredit(1);
		});

		this.receivers.push(receiver);
	}

	/**
	 * Subscribe to balanced event command
	 * For EVENTB command types
	 * These queues will be used when the "disableBalancer" set to true
	 *
	 * @param {String} event
	 * @param {String} group
	 * @memberof Amqp10Transporter
	 */
	async subscribeBalancedEvent(event, group) {
		const queue = `${this.prefix}.${PACKET_EVENT}B.${group}.${event}`;
		const receiverOptions = Object.assign(
			{
				source: { address: queue },
				autoaccept: false
			},
			this._getQueueOptions(PACKET_EVENT + "LB", true)
		);
		const receiver = await this.connection.createReceiver(receiverOptions);
		receiver.on("message", this._consumeCB(PACKET_EVENT, true));

		this.receivers.push(receiver);
	}

	/**
	 * Publish a packet
	 *
	 * @param {Packet} packet
	 *
	 * @memberof Amqp10Transporter
	 * @description Send packets to their intended queues / topics.
	 *
	 * Reasonings documented in the subscribe method.
	 */
	async publish(packet) {
		/* istanbul ignore next*/
		if (!this.connection) return;

		let topic = this.getTopicName(packet.type, packet.target);

		const data = this.serialize(packet);
		const message = Object.assign({ body: data }, this.opts.messageOptions, this._getMessageOptions(packet.type));
		const awaitableSenderOptions = {
			target: {
				address: packet.target ? topic : `${this.opts.topicPrefix}${topic}`
			}
		};
		try {
			const sender = await this.connection.createAwaitableSender(awaitableSenderOptions);
			await sender.send(message);
			this.incStatSent(data.length);
			await sender.close();
		} catch (error) {
			this.logger.error(error);
		}
	}

	/**
	 * Publish a balanced EVENT(B) packet to a balanced queue
	 *
	 * @param {Packet} packet
	 * @param {String} group
	 * @returns {Promise}
	 * @memberof Amqp10Transporter
	 */
	async publishBalancedEvent(packet, group) {
		/* istanbul ignore next*/
		if (!this.connection) return;

		let queue = `${this.prefix}.${PACKET_EVENT}B.${group}.${packet.payload.event}`;
		const data = this.serialize(packet);
		const message = Object.assign({ body: data }, this.opts.messageOptions, this._getMessageOptions(PACKET_EVENT, true));
		const awaitableSenderOptions = {
			target: {
				address: queue
			}
		};
		try {
			const sender = await this.connection.createAwaitableSender(awaitableSenderOptions);
			await sender.send(message);
			this.incStatSent(data.length);
			await sender.close();
		} catch (error) {
			this.logger.error(error);
		}
	}

	/**
	 * Publish a balanced REQ(B) packet to a balanced queue
	 *
	 * @param {Packet} packet
	 * @returns {Promise}
	 * @memberof Amqp10Transporter
	 */
	async publishBalancedRequest(packet) {
		/* istanbul ignore next*/
		if (!this.connection) return Promise.resolve();

		const queue = `${this.prefix}.${PACKET_REQUEST}B.${packet.payload.action}`;

		const data = this.serialize(packet);
		const message = Object.assign({ body: data }, this.opts.messageOptions, this._getMessageOptions(PACKET_REQUEST, true));
		const awaitableSenderOptions = {
			target: {
				address: queue
			}
		};
		try {
			const sender = await this.connection.createAwaitableSender(awaitableSenderOptions);
			await sender.send(message);
			this.incStatSent(data.length);
			await sender.close();
		} catch (error) {
			this.logger.error(error);
		}
	}
}

module.exports = Amqp10Transporter;
