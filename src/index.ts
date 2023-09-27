import cors from '@fastify/cors';
import { HTTPMethods, fastify } from 'fastify';
import websocket, { SocketStream } from '@fastify/websocket'
import * as mqtt from "mqtt";
import * as Protobuf from "protobufjs";

type device = {
    mac: string,
    hardware?: number,
    devName?: string,
    broadcastMsg?: string;
    pos: {
        long: number,
        lat: number,
        altitude: number,
    }
    name?: string,
    lastSeen: number;
}

type Msg = {
    packet: {
        decoded: {
            payload: Buffer;
        }
    }
};

interface meshtasticJSON {
    from: number,
    to: number,
    id: number,
    gateway: string,
    timestamp: number,
    type: string
    payload: {
        hardware?: number,
        id?: string,
        longname?: string,
        altitude?: number,
        latitude_i?: number,
        longitude_i?: number,
        text?: string,
    },
}

function isLessThan24HoursAgo(timestamp: number) {
    const twentyFourHoursAgo = Math.floor(new Date().getTime() / 1000) - 24 * 60 * 60; 
    return timestamp > twentyFourHoursAgo;
}
function getMacFromID(decimal: number) {
    var size = 8;
  
    if (decimal >= 0) {
      let hexadecimal: string = decimal.toString(16);
  
      while ((hexadecimal.length % size) != 0) {
        hexadecimal = "" + 0 + hexadecimal;
      }
  
      return '!' + hexadecimal;
    } else {
      var hexadecimal = Math.abs(decimal).toString(16);
      while ((hexadecimal.length % size) != 0) {
        hexadecimal = "" + 0 + hexadecimal;
      }
  
      let output = '';
      for (let i = 0; i < hexadecimal.length; i++) {
        output += (0x0F - parseInt(hexadecimal[i], 16)).toString(16);
      }
  
      output = (0x01 + parseInt(output, 16)).toString(16);
      return '!' + output;
    }
  }

async function main(args: string[]): Promise<void> {

    const root = Protobuf.loadSync([
        '../meshtastic-protobufs/meshtastic/channel.proto',
        '../meshtastic-protobufs/meshtastic/xmodem.proto',
        '../meshtastic-protobufs/meshtastic/config.proto',
        '../meshtastic-protobufs/meshtastic/module_config.proto',
        '../meshtastic-protobufs/meshtastic/mqtt.proto',
        '../meshtastic-protobufs/meshtastic/portnums.proto',
        '../meshtastic-protobufs/meshtastic/deviceonly.proto',
        '../meshtastic-protobufs/meshtastic/telemetry.proto',
        '../meshtastic-protobufs/meshtastic/mesh.proto']);
    const fromMQTT = root.lookupType('meshtastic.ServiceEnvelope');
    const positionLite = root.lookupType('meshtastic.PositionLite');
    const nodeInfo = root.lookupType('meshtastic.User');
    const telemetryInfo = root.lookupType('meshtastic.Telemetry');

    const brokerUrl = 'mqtts://platform.meshbrasil.com:1883';
    //const brokerUrl = 'mqtts://localhost:1883';
    const mqttClient = mqtt.connect(brokerUrl, {
        rejectUnauthorized: false, 
        username: 'root',
        password: 'testee',
    });

    mqttClient.on('connect', () => {
        console.log(`Connected to MQTT broker: ${brokerUrl}`);
    });
    const topic = '#';
    mqttClient.subscribe(topic, (err) => {
        if (!err) {
          console.log(`Subscribed to topic: ${topic}`);
        } else {
          console.error(`Failed to subscribe to topic: ${topic}`);
        }
    });

    const server = fastify({ logger: true });
    const methods: HTTPMethods[] = ['GET'];

    await server.register(websocket);

    await server.register(cors, {
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
        exposedHeaders: ['Content-Length'],
        methods,
        origin: ['https://platform.meshtastic.com', 'http://localhost:3005'],
    });

    const connectedClients = new Set<SocketStream>();
    let userBuffer: device[] = [];

    await server.register(async function () {
        server.route({
            method: 'GET',
            url: '/positions/',
            handler: (req, reply) => { reply.send({ message: 'this route does not exist' }) },
            // schema: {querystring: {
            //     type: 'object',
            //     properties: {
            //         uid_array: {
            //         type: 'string',
            //         format: 'regex',
            //         pattern: `^[a-zA-Z0-9-_]{36}$`,
            //     }}
            // }},
            wsHandler: async (connection, request) => {

                connectedClients.add(connection);
                const filteredResults = userBuffer.filter((device) => isLessThan24HoursAgo(device.lastSeen));
                userBuffer = filteredResults;
                
                console.log("Synching with client", userBuffer);
                if (userBuffer.length > 0) {
                    connection.socket.send(JSON.stringify(userBuffer));
                }

                connection.socket.on('close', () => {
                    connectedClients.delete(connection);
                })
            }
        });
    });

    await server.ready();

    server.listen({ port: 3004 }, (err, address) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Server listening on ${address}`);
    });

    mqttClient.on('message', (receivedTopic, message) => {
        console.log(`Received message on topic: ${receivedTopic}`);

        try {
            JSON.parse(message.toString());
            return;
        }
        catch(e) {}
        
        let parsedMessage: meshtasticJSON;
        try {
            const rawraw = fromMQTT.decode(message);
            const raw = rawraw.toJSON();

            parsedMessage = {
                from: raw.packet.from,
                to: raw.packet.to,
                id: raw.packet.id,
                gateway: raw.gatewayId,
                type: raw.packet.decoded.portnum,
                timestamp: raw.packet.rxTime,
                payload: {}
            }

            switch (raw.packet.decoded.portnum) {
                case 'POSITION_APP':
                    const position = positionLite.decode(((rawraw as unknown) as Msg).packet.decoded.payload).toJSON();
                    parsedMessage.payload = {
                        altitude: position.altitude,
                        longitude_i: position.longitudeI,
                        latitude_i: position.latitudeI,
                    }
                    break;

                case 'NODEINFO_APP':
                    const nodeinfo = nodeInfo.decode(((rawraw as unknown) as Msg).packet.decoded.payload).toJSON();
                    console.log(nodeinfo);
                    parsedMessage.payload = {
                        hardware: nodeinfo.hwModel,
                        longname: nodeinfo.longName,
                        id: nodeinfo.id
                    }
                    break;

                case 'TEXT_MESSAGE_APP':
                    parsedMessage.payload.text = atob(raw.packet.decoded.payload);
                    break;
                case 'TELEMETRY_APP':
                    //const telemetry = telemetryInfo.decode(((rawraw as unknown) as Msg).packet.decoded.payload).toJSON();
                    //console.log(telemetryInfo);
                    break;
                case '':
                    return;
            }
        }
        catch (e) {
            //console.log(e);
            return;
        }

        const index = userBuffer.findIndex((device) => device.mac === getMacFromID(parsedMessage.from));
        let update: device;

        switch (parsedMessage.type) {
            case 'POSITION_APP':
                if (parsedMessage.payload.longitude_i != 0 && parsedMessage.payload.latitude_i != 0) {
                    if (index >= 0) {

                        userBuffer[index].lastSeen = parsedMessage.timestamp;
                        userBuffer[index].pos = {
                            altitude: parsedMessage.payload.altitude!,
                            long: parsedMessage.payload.longitude_i! / 10000000,
                            lat: parsedMessage.payload.latitude_i! / 10000000,
                        };

                        update = userBuffer[index];
                    }
                    else {
                        update = {
                            mac: getMacFromID(parsedMessage.from),
                            pos: {
                                altitude: parsedMessage.payload.altitude!,
                                long: parsedMessage.payload.longitude_i! / 10000000,
                                lat: parsedMessage.payload.latitude_i! / 10000000,
                            },
                            lastSeen: parsedMessage.timestamp
                        };

                        userBuffer.push(update);
                    }

                    connectedClients.forEach((connection) => {
                        connection.socket.send(JSON.stringify([update]));
                    });
                }
                break;
            case 'NODEINFO_APP':
                if (index >= 0) {

                    userBuffer[index].hardware = parsedMessage.payload.hardware;
                    userBuffer[index].devName = parsedMessage.payload.longname;

                    update = userBuffer[index];
                    connectedClients.forEach((connection) => {
                        connection.socket.send(JSON.stringify([update]));
                    });
                }
                break;
            case 'TEXT_MESSAGE_APP':
                console.log(getMacFromID(parsedMessage.from))
                if (index >= 0 && getMacFromID(parsedMessage.from) == parsedMessage.gateway && parsedMessage.payload.text && parsedMessage.payload.text[0] == '#') {

                    userBuffer[index].broadcastMsg = parsedMessage.payload.text.substring(1);

                    update = userBuffer[index];
                    connectedClients.forEach((connection) => {
                        connection.socket.send(JSON.stringify([update]));
                    });
                }
                break;
        }
    });
}

if (process.argv.length !== 3) {
    console.error('Usage: node <PATH_TO_INDEX.JS> <PATH_TO_OPTIONS_FILE>');
    process.exit(1);
}
const args = process.argv.slice(2);

main(args).then(
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    () => { },
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
