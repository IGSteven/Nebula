// Import packages.
// import cluster from 'cluster';
// import os from 'os';
const WebSocket = require('ws');
const Redis = require('redis');
const { FusionAuthClient } = require('@fusionauth/typescript-client')
require('dotenv').config()

// Setup FusionAuth client.
const fusion = new FusionAuthClient(process.env.FUSIONAUTH_KEY, process.env.FUSIONAUTH_URL);

// Setup WebSocket server.
const wss = new WebSocket.Server({ port: 9001 });

// Setup Redis connection.
let red = Redis.createClient({ host: process.env.REDIS_HOST });
let pub = Redis.createClient({ host: process.env.REDIS_HOST });
let sub = Redis.createClient({ host: process.env.REDIS_HOST });

// Redis authentication.
red.auth(process.env.REDIS_PASS);
pub.auth(process.env.REDIS_PASS);
sub.auth(process.env.REDIS_PASS);

// Subscribe to Redis pub/sub.
sub.subscribe('chat');

// Clear Redis.
red.flushall();

// Create list of all connected clients.
let clients = {};

// Broadcast message to all clients connected to this node.
sub.on('message', function(channel, data) {
    if(channel !== 'chat') { return; }

    data = JSON.parse(data);

    // Check if message length is over 500 characters.
    if(data.data.message.length > 500) {
        return;
    }

    // Check if blank message.
    if(data.data.message.match(/^\s*$/)) {
        return;
    }

    for(let i = 0; i < clients[data.channel].length; i++) {
        clients[data.channel][i].send(JSON.stringify(data.data));
    }
});

// Make sure client is connected.
function noop() {}
function heartbeat() {
    this.isAlive = true;
}

// Listen for connection.
wss.on('connection', function connection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    // Get requested channel id.
    const channel = req.url.substr(1);

    // Create empty viewer and badges.
    let viewer;
    let badges = [];

    // Check if channel exists on connection.
    fusion.retrieveUser(channel)
        .then()
        .catch(() => {
            return ws.terminate();
        }
    );

    // On new message.
    ws.on('message', function incoming(data) {
        // Convert data to JSON.
        try {
            data = JSON.parse(data);
        } catch(error) {
            return ws.terminate();
        }

        // Join event.
        if(data.event === 'join') {
            // Check if guest connected.
            if(data.data === 'guest') {
                viewer = 'guest';
            } else {
                // Check if user is authenticated.
                fusion.retrieveUserUsingJWT(data.data)
                    .then(ClientResponse => {
                        viewer = {
                            'id': ClientResponse.response.user.id,
                            'username': ClientResponse.response.user.username
                        };

                        ClientResponse.response.user.memberships.forEach(group => {
                            fusion.retrieveGroup(group.groupId).then(groupInfo => {
                                switch (groupInfo.response.group.name) {
                                    case 'Founder':
                                        badges.push({
                                            name: 'Founder',
                                            icon: 'code',
                                            color: 'D66853'
                                        });
                                        break;
                                }
                            });
                        });

                        // Add viewer to Redis list.
                        red.sadd(`stream:${channel}:viewers`, JSON.stringify(viewer));
                    }).catch(error => {
                    console.log(error);
                    return ws.terminate();
                });
            }

            // Check if channel exits in clients.
            if(!clients[channel]) {
                clients[channel] = [];
            }

            // Add to list of clients in specifcied channel.
            clients[channel].push(ws);
        }

        // Message event.
        if(data.event === 'message') {
            if(viewer !== 'guest') {
                // Make sure channel client list has been created.
                if(clients[channel]) {
                    // Make sure user is authenticated.
                    if(clients[channel].indexOf(ws) === -1) {
                        console.log('fail 1');
                        return ws.terminate();
                    }
                } else {
                    return ws.terminate();
                }

                // Publish message to Redis.
                pub.publish('chat', JSON.stringify({
                    'channel': channel,
                    'data': {
                        'viewer': viewer,
                        'badges': badges,
                        'message': data.data
                    },
                }));
            }
        }
    });

    // On close.
    ws.on('close', function close() {
        // Make sure channel client list has been created.
        if(clients[channel]) {
            // Remove client from clients list.
            clients[channel].splice(clients[channel].indexOf(ws), 1);

            // Remove client from redis list.
            try {
                red.srem(`stream:${channel}:viewers`, 1, JSON.stringify(viewer));
            } catch(err) {
                console.log(err);
            }
        } else {
            //return viewer.terminate();
        }
    });
});

const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if(ws.isAlive === false) return ws.terminate();

        ws.isAlive = false;
        ws.ping(noop);
    });
}, 5000);

wss.on('close', function close() {
    console.log('Nebula has stopped.');

    clearInterval(interval);
});
