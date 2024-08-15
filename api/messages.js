const express = require('express');
const globalUtils = require('../helpers/globalutils');
const { logText } = require('../helpers/logger');
const { channelPermissionsMiddleware, rateLimitMiddleware } = require('../helpers/middlewares');
const fs = require('fs');
const multer = require('multer');
const sizeOf = require('image-size');
const Snowflake = require('../helpers/snowflake');
const reactions = require('./reactions');

const upload = multer();
const router = express.Router({ mergeParams: true });

router.param('messageid', async (req, res, next, messageid) => {
    req.message = await global.database.getMessageById(messageid, req.client_build);

    next();
});

router.use("/:messageid/reactions", reactions);

function handleJsonAndMultipart(req, res, next) {
    const contentType = req.headers['content-type'];
    if (contentType && contentType.startsWith('multipart/form-data')) {
        upload.single('file')(req, res, next);
    } else {
        express.json()(req, res, next);
    }
}

router.get("/", channelPermissionsMiddleware("READ_MESSAGE_HISTORY"), async (req, res) => {
    try {
        const creator = req.account;

        if (creator == null) {
            return res.status(401).json({
                code: 401,
                message: "Unauthorized"
            });
        }

        const channel = req.channel;

        if (channel == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Channel"
            });
        }

        let limit = parseInt(req.query.limit) || 200;

        if (limit > 200) {
            limit = 200;
        }

        let includeReactions = req.guild && !req.guild.exclusions.includes("reactions");

        let messages = await global.database.getChannelMessages(channel.id, limit, req.query.before, req.query.after, includeReactions);

        for(var msg of messages) {
            if (msg.reactions) {
                for(var reaction of msg.reactions) {
                    reaction.me = reaction.user_ids.includes(creator.id);
                        
                    delete reaction.user_ids;
                }
            }
        }

        return res.status(200).json(messages);
    } catch (error) {
        logText(error, "error");

        return res.status(500).json({
            code: 500,
            message: "Internal Server Error"
        });
    }
});

router.post("/", handleJsonAndMultipart, channelPermissionsMiddleware("SEND_MESSAGES"), rateLimitMiddleware(5, 1000 * 10), rateLimitMiddleware(1000, 1000 * 60 * 60), async (req, res) => {
    try {
        const creator = req.account;

        if (creator == null) {
            return res.status(401).json({
                code: 401,
                message: "Unauthorized"
            });
        }

        const channel = req.channel;

        if (channel == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Channel"
            });
        }

        let finalContent = req.body.content;

        if (req.body.mentions && req.body.mentions.length > 0) {
            const mentions= req.body.mentions;
            
            for(let mention of mentions) {
                const user = await global.database.getAccountByUserId(mention);

                if (user != null) {
                    finalContent = finalContent.replace(`@${user.username}`, `<@${user.id}>`);
                }
            }

            req.body.content = finalContent;
        }

        if (finalContent && finalContent.includes("@everyone")) {
            let pCheck = await global.permissions.hasChannelPermissionTo(req.channel, req.guild, creator.id, "MENTION_EVERYONE");

            if (!pCheck) {
                finalContent = finalContent.replace(/@everyone/g, "");
            } 

            req.body.content = finalContent;
        }

        if (channel.recipient != null) {
            const recipient = await global.database.getAccountByUserId(channel.recipient.id);

            if (recipient == null || !recipient.token) {
                return res.status(404).json({
                    code: 404,
                    message: "Unknown Channel"
                });
            }

            if (req.file) {
                let attachment_id = Snowflake.generate();
    
                let name = req.file.originalname.split(".")[0];
                let extension = req.file.originalname.split(".")[1];
                let size = req.file.size;
                
                if (!fs.existsSync(`./user_assets/attachments/${channel.id}`)) {
                    fs.mkdirSync(`./user_assets/attachments/${channel.id}`, { recursive: true });
                }
    
                if (!fs.existsSync(`./user_assets/attachments/${channel.id}/${attachment_id}`)) {
                    fs.mkdirSync(`./user_assets/attachments/${channel.id}/${attachment_id}`, { recursive: true });
                }
    
                fs.writeFileSync(`./user_assets/attachments/${channel.id}/${attachment_id}/${name}.${extension}`, req.file.buffer);
    
                sizeOf(`./user_assets/attachments/${channel.id}/${attachment_id}/${name}.${extension}`, async (err, dimensions) => {
                    const attachment = {
                        id: attachment_id,
                        size: size,
                        width: dimensions?.width,
                        height: dimensions?.height,
                        name: `${name}.${extension}`,
                        extension: extension
                    };
    
                    const createMessage = await global.database.createMessage(!channel.guild_id ? null : channel.guild_id, channel.id, creator.id, req.body.content, req.body.nonce, attachment, false);

                    if (createMessage == null) {
                        return res.status(500).json({
                            code: 500,
                            message: "Internal Server Error"
                        });
                    }

                    await global.dispatcher.dispatchInDM(creator.id, recipient.id, "MESSAGE_CREATE", createMessage);

                    return res.status(200).json(createMessage);
                });
            } else {
                const createMessage = await global.database.createMessage(!channel.guild_id ? null : channel.guild_id, channel.id, creator.id, req.body.content, req.body.nonce, null, req.body.tts);
    
                if (createMessage == null) {
                    return res.status(500).json({
                        code: 500,
                        message: "Internal Server Error"
                    });
                }
        
                await global.dispatcher.dispatchInDM(creator.id, recipient.id, "MESSAGE_CREATE", createMessage);
        
                return res.status(200).json(createMessage);
            }
        } else {
            if (!channel.guild_id) {
                return res.status(404).json({
                    code: 404,
                    message: "Unknown Channel"
                });
            }

            let canUseEmojis = !req.guild.exclusions.includes("custom_emoji");

            const emojiPattern = /<:[\w-]+:\d+>/g;

            const hasEmojiFormat = emojiPattern.test(req.body.content);

            if (hasEmojiFormat && !canUseEmojis) {
                return res.status(400).json({
                    code: 400,
                    message: "Custom emojis are disabled in this server due to its maximum support"
                });
            }

            if (req.body.tts == true) {
                let canTts = await global.permissions.hasChannelPermissionTo(req.channel, req.guild, creator.id, "SEND_TTS_MESSAGES");

                if (!canTts) {
                    req.body.tts = canTts;
                }
            }
    
            if (req.file) {
                let attachment_id = Snowflake.generate();
    
                let name = req.file.originalname.split(".")[0];
                let extension = req.file.originalname.split(".")[1];
                let size = req.file.size;
    
                if (!fs.existsSync(`./user_assets/attachments/${channel.id}`)) {
                    fs.mkdirSync(`./user_assets/attachments/${channel.id}`, { recursive: true });
                }
    
                if (!fs.existsSync(`./user_assets/attachments/${channel.id}/${attachment_id}`)) {
                    fs.mkdirSync(`./user_assets/attachments/${channel.id}/${attachment_id}`, { recursive: true });
                }
    
                fs.writeFileSync(`./user_assets/attachments/${channel.id}/${attachment_id}/${name}.${extension}`, req.file.buffer);
                
                if (!req.body.tts) {
                    req.body.tts = "false";
                }

                if (req.body.tts == "true") {
                    let canTts = await global.permissions.hasChannelPermissionTo(req.channel, req.guild, creator.id, "SEND_TTS_MESSAGES");
    
                    if (!canTts) {
                        req.body.tts = "false";
                    }
                }

                sizeOf(`./user_assets/attachments/${channel.id}/${attachment_id}/${name}.${extension}`, async (err, dimensions) => {
                    const attachment = {
                        id: attachment_id,
                        size: size,
                        width: dimensions?.width,
                        height: dimensions?.height,
                        name: `${name}.${extension}`,
                        extension: extension
                    };
    
                    const createMessage = await global.database.createMessage(!channel.guild_id ? null : channel.guild_id, channel.id, creator.id, req.body.content, req.body.nonce, attachment, req.body.tts == "false" ? false : true);

                    if (createMessage == null) {
                        return res.status(500).json({
                            code: 500,
                            message: "Internal Server Error"
                        });
                    }
            
                    await global.dispatcher.dispatchEventInChannel(channel.id, "MESSAGE_CREATE", createMessage);
            
                    return res.status(200).json(createMessage);
                });
            } else {
                if (!req.body.tts) {
                    req.body.tts = false;
                }

                const createMessage = await global.database.createMessage(!channel.guild_id ? null : channel.guild_id, channel.id, creator.id, req.body.content, req.body.nonce, null, req.body.tts);
    
                if (createMessage == null) {
                    return res.status(500).json({
                        code: 500,
                        message: "Internal Server Error"
                    });
                }
        
                await global.dispatcher.dispatchEventInChannel(channel.id, "MESSAGE_CREATE", createMessage);
        
                return res.status(200).json(createMessage);
            }
        }
      } catch (error) {
        console.log(error);

        logText(error, "error");
    
        return res.status(500).json({
          code: 500,
          message: "Internal Server Error"
        });
    }
});

router.delete("/:messageid", channelPermissionsMiddleware("MANAGE_MESSAGES"), rateLimitMiddleware(5, 1000 * 10), rateLimitMiddleware(1000, 1000 * 60 * 60, true), async (req, res) => {
    try {
        const guy = req.account;

        if (guy == null) {
            return res.status(401).json({
                code: 401,
                message: "Unauthorized"
            });
        }

        const message = req.message;

        if (message == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Message"
            });
        }

        const channel = req.channel;

        if (channel == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Channel"
            });
        }

        if (channel.recipient != null) {
            if (message.author.id != guy.id) {
                return res.status(403).json({
                    code: 403,
                    message: "Missing Permissions"
                });
            }
    
            const del = await global.database.deleteMessage(req.params.messageid);
    
            if (!del) {
                return res.status(500).json({
                    code: 500,
                    message: "Internal Server Error"
                });
            }

            await global.dispatcher.dispatchInDM(guy.id, channel.recipient.id, "MESSAGE_DELETE", {
                id: req.params.messageid,
                guild_id: channel.guild_id,
                channel_id: req.params.channelid
            });
    
            return res.status(204).send();
        } else {
            if (!channel.guild_id) {
                return res.status(404).json({
                    code: 404,
                    message: "Unknown Channel"
                });
            }
    
            const del = await global.database.deleteMessage(req.params.messageid);
    
            if (!del) {
                return res.status(500).json({
                    code: 500,
                    message: "Internal Server Error"
                });
            }
    
            await global.dispatcher.dispatchEventInChannel(channel.id, "MESSAGE_DELETE", {
                id: req.params.messageid,
                guild_id: channel.guild_id,
                channel_id: req.params.channelid
            })
    
            return res.status(204).send();
        }
        
    } catch (error) {
        logText(error, "error");
    
        return res.status(500).json({
          code: 500,
          message: "Internal Server Error"
        });
    }
});

router.patch("/:messageid", rateLimitMiddleware(5, 1000 * 10, true), rateLimitMiddleware(1000, 1000 * 60 * 60), async (req, res) => {
    try {
        if (req.body.content && req.body.content == "") {
            return res.status(403).json({
                code: 403,
                message: "Missing Permissions"
            });
        }
        
        const guy = req.account;

        if (guy == null) {
            return res.status(401).json({
                code: 401,
                message: "Unauthorized"
            });
        }

        let message = req.message;

        if (message == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Message"
            });
        }

        const channel = req.channel;

        if (channel == null) {
            return res.status(500).json({
                code: 500,
                message: "Internal Server Error"
            });
        }

        if (channel.recipient != null) {
            if (message.author.id != guy.id) {
                return res.status(403).json({
                    code: 403,
                    message: "Missing Permissions"
                });
            }

            let finalContent = req.body.content;

            if (req.body.mentions && req.body.mentions.length > 0) {
                const mentions = req.body.mentions;
                
                for(let mention of mentions) {
                    const user = await global.database.getAccountByUserId(mention);

                    if (user != null) {
                        finalContent = finalContent.replace(`@${user.username}`, `<@${user.id}>`);
                    }
                }

                req.body.content = finalContent;
            }

            if (finalContent && finalContent.includes("@everyone")) {
                let pCheck = await global.permissions.hasChannelPermissionTo(req.channel, req.guild, message.author.id, "MENTION_EVERYONE");

                if (!pCheck) {
                    finalContent = finalContent.replace(/@everyone/g, "");
                } 

                req.body.content = finalContent;
            }

            const update = await global.database.updateMessage(message.id, req.body.content);

            if (!update) {
                return res.status(500).json({
                    code: 500,
                    message: "Internal Server Error"
                });
            }

            message = await global.database.getMessageById(req.params.messageid, req.client_build);

            if (message == null) {
                return res.status(404).json({
                    code: 404,
                    message: "Unknown Message"
                });
            }

            await global.dispatcher.dispatchInDM(guy.id, channel.recipient.id, "MESSAGE_UPDATE", message);

            return res.status(204).send();
        } else {
            if (!channel.guild_id) {
                return res.status(404).json({
                    code: 404,
                    message: "Unknown Channel"
                });
            }
            
            if (message.author.id != guy.id) {
                return res.status(403).json({
                    code: 403,
                    message: "Missing Permissions"
                });
            }

            let finalContent = req.body.content;

            if (req.body.mentions && req.body.mentions.length > 0) {
                const mentions= req.body.mentions;
                
                for(let mention of mentions) {
                    const user = await global.database.getAccountByUserId(mention);

                    if (user != null) {
                        finalContent = finalContent.replace(`@${user.username}`, `<@${user.id}>`);
                    }
                }

                req.body.content = finalContent;
            }

            if (finalContent && finalContent.includes("@everyone")) {
                let pCheck = await global.permissions.hasChannelPermissionTo(req.channel, req.guild, message.author.id, "MENTION_EVERYONE");

                if (!pCheck) {
                    finalContent = finalContent.replace(/@everyone/g, "");
                } 

                req.body.content = finalContent;
            }

            const update = await global.database.updateMessage(message.id, req.body.content);

            if (!update) {
                return res.status(500).json({
                    code: 500,
                    message: "Internal Server Error"
                });
            }

            message = await global.database.getMessageById(req.params.messageid, req.client_build);

            if (message == null) {
                return res.status(404).json({
                    code: 404,
                    message: "Unknown Message"
                });
            }

            await global.dispatcher.dispatchEventInChannel(channel.id, "MESSAGE_UPDATE", message);

            return res.status(204).send();
        }
    } catch (error) {
        logText(error, "error");
    
        return res.status(500).json({
          code: 500,
          message: "Internal Server Error"
        });
    }
});

router.post("/:messageid/ack", rateLimitMiddleware(5, 1000 * 10), rateLimitMiddleware(1000, 1000 * 60 * 60), async (req, res) => {
    try {
        const guy = req.account;

        if (guy == null || !guy.token) {
            return res.status(401).json({
                code: 401,
                message: "Unauthorized"
            });
        }

        const message = req.message;

        if (message == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Message"
            });
        }

        const channel = req.channel;

        if (channel == null) {
            return res.status(404).json({
                code: 404,
                message: "Unknown Channel"
            });
        }

        let tryAck = await global.database.acknowledgeMessage(guy.id, channel.id, message.id, 0);

        if (!tryAck) {
            return res.status(500).json({
                code: 500,
                message: "Internal Server Error"
            });
        }

        await global.dispatcher.dispatchEventTo(guy.id, "MESSAGE_ACK", {
            channel_id: channel.id,
            message_id: message.id
        });
        
        return res.status(200).json({
            token: globalUtils.generateToken(guy.id, globalUtils.generateString(20))
        })
    } catch (error) {
        logText(error, "error");
    
        return res.status(500).json({
          code: 500,
          message: "Internal Server Error"
        });
    }
});

module.exports = router;