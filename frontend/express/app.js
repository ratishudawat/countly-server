require('log-timestamp');

var versionInfo = require('./version.info'),
    COUNTLY_VERSION = versionInfo.version,
    COUNTLY_TYPE = versionInfo.type,
    http = require('http'),
    express = require('express'),
    SkinStore = require('connect-mongoskin'),
    expose = require('express-expose'),
    mongo = require('mongoskin'),
    crypto = require('crypto'),
    fs = require('fs'),
    im = require('imagemagick'),
    request = require('request'),
    async = require('async'),
    stringJS = require('string'),
    countlyMail = require('../../api/parts/mgmt/mail.js'),
    countlyStats = require('../../api/parts/data/stats.js'),
	plugins = require('../../plugins/pluginManager.js'),
    countlyConfig = require('./config');
    
plugins.setConfigs("frontend", {
    production: false,
    session_timeout: 30*60*1000,
});

//mongodb://[username:password@]host1[:port1][,host2[:port2],...[,hostN[:portN]]][/[database][?options]]
var dbName;
var dbOptions = {
	server:{auto_reconnect:true, poolSize: countlyConfig.mongodb.max_pool_size, socketOptions: { keepAlive: 30000, connectTimeoutMS: 0, socketTimeoutMS: 0 }},
	replSet:{socketOptions: { keepAlive: 30000, connectTimeoutMS: 0, socketTimeoutMS: 0 }},
	mongos:{socketOptions: { keepAlive: 30000, connectTimeoutMS: 0, socketTimeoutMS: 0 }}
};

if (typeof countlyConfig.mongodb === "string") {
    dbName = countlyConfig.mongodb;
} else{
	countlyConfig.mongodb.db = countlyConfig.mongodb.db || 'countly';
	if ( typeof countlyConfig.mongodb.replSetServers === 'object'){
		//mongodb://db1.example.net,db2.example.net:2500/?replicaSet=test
		dbName = countlyConfig.mongodb.replSetServers.join(",")+"/"+countlyConfig.mongodb.db;
		if(countlyConfig.mongodb.replicaName){
			dbOptions.replSet.rs_name = countlyConfig.mongodb.replicaName;
		}
	} else {
		dbName = (countlyConfig.mongodb.host + ':' + countlyConfig.mongodb.port + '/' + countlyConfig.mongodb.db);
	}
}
if(countlyConfig.mongodb.username && countlyConfig.mongodb.password){
	dbName = countlyConfig.mongodb.username + ":" + countlyConfig.mongodb.password +"@" + dbName;
}
if(dbName.indexOf("mongodb://") !== 0){
	dbName = "mongodb://"+dbName;
}
var countlyDb = mongo.db(dbName, dbOptions);
countlyDb._emitter.setMaxListeners(0);
if(!countlyDb.ObjectID)
	countlyDb.ObjectID = mongo.ObjectID;

function sha1Hash(str, addSalt) {
    var salt = (addSalt) ? new Date().getTime() : "";
    return crypto.createHmac('sha1', salt + "").update(str + "").digest('hex');
}

function md5Hash(str) {
    return crypto.createHash('md5').update(str + "").digest('hex');
}

function isGlobalAdmin(req) {
    return (req.session.gadm);
}

function sortBy(arrayToSort, sortList) {
    if (!sortList.length) {
        return arrayToSort;
    }

    var tmpArr = [],
        retArr = [];

    for (var i = 0; i < arrayToSort.length; i++) {
        var objId = arrayToSort[i]["_id"] + "";
        if (sortList.indexOf(objId) !== -1) {
            tmpArr[sortList.indexOf(objId)] = arrayToSort[i];
        }
    }

    for (var i = 0; i < tmpArr.length; i++) {
        if (tmpArr[i]) {
            retArr[retArr.length] = tmpArr[i];
        }
    }

    for (var i = 0; i < arrayToSort.length; i++) {
        if (retArr.indexOf(arrayToSort[i]) === -1) {
            retArr[retArr.length] = arrayToSort[i];
        }
    }

    return retArr;
}

var app = express();

app.configure(function () {
    app.engine('html', require('ejs').renderFile);
    app.set('views', __dirname + '/views');
    app.set('view engine', 'html');
    app.set('view options', {layout:false});
    app.use(express.bodyParser({uploadDir:__dirname + '/uploads'}));
    app.use(express.cookieParser());
    app.use(express.session({
        secret:'countlyss',
        store:new SkinStore(countlyDb)
    }));
    app.use(require('connect-flash')());
    app.use(function(req, res, next) {
        res.locals.flash = req.flash.bind(req);
        req.config = plugins.getConfig("frontend");
        next();
    });
    app.use(express.methodOverride());
    var csrf = express.csrf();
    app.use(function (req, res, next) {
        if (req.method == "GET" || req.method == 'HEAD' || req.method == 'OPTIONS'){
            //csrf not used, but lets regenerate token
            csrf(req, res, next);
        }
        else if (!plugins.callMethod("skipCSRF", {req:req, res:res, next:next})) {
            //none of the plugins requested to skip csrf for this request
            csrf(req, res, next);
        } else {
            //skipping csrf step, some plugin needs it without csrf
            next();
        }
    });
    plugins.loadAppStatic(app, countlyDb, express);
    var oneYear = 31557600000;
    app.use(countlyConfig.path, express.static(__dirname + '/public'), { maxAge:oneYear });
	plugins.loadAppPlugins(app, countlyDb, express);
    app.use(app.router);
});



app.configure('development', function () {
    app.use(express.errorHandler({ dumpExceptions:true, showStack:true }));
});

app.configure('production', function () {
    app.use(express.errorHandler());
});

app.get(countlyConfig.path+'/', function (req, res, next) {
    res.redirect(countlyConfig.path+'/login');
});

//serve app images
app.get(countlyConfig.path+'/appimages/*', function(req, res) {
	fs.exists(__dirname + '/public' + req.url, function(exists) {
		if (exists) {
			res.sendfile(__dirname + '/public' + req.url);
		} else {
			res.sendfile(__dirname + '/public/images/default_app_icon.png');
		}
	});
});

if(plugins.getConfig("frontend").session_timeout){
	var extendSession = function(req, res, next){
		req.session.expires = Date.now() + plugins.getConfig("frontend").session_timeout;
	};
	var checkRequestForSession = function(req, res, next){
		if (req.session.uid) {
			if(Date.now() > req.session.expires){
				//logout user
				res.redirect(countlyConfig.path+'/logout?message=logout.inactivity');
			}
			else{
				//extend session
				extendSession(req, res, next);
				next();
			}
		}
		else
			next();
	};
	
	app.get(countlyConfig.path+'/session', function(req, res, next) {
		if (req.session.uid) {
			if(Date.now() > req.session.expires){
				//logout user
				res.send("logout");
			}
			else{
				//extend session
				extendSession(req, res, next);
				res.send("success");
			}
		}
		else
			res.send("login");
	});
	app.get(countlyConfig.path+'/dashboard', checkRequestForSession);
	app.post('*', checkRequestForSession);
}

app.get(countlyConfig.path+'/logout', function (req, res, next) {
    if (req.session) {
        plugins.callMethod("userLogout", {req:req, res:res, next:next, data:{uid:req.session.uid, email:req.session.email}});
        req.session.uid = null;
        req.session.gadm = null;
        req.session.email = null;
        res.clearCookie('uid');
        res.clearCookie('gadm');
        req.session.destroy(function () {
        });
    }
	if(req.query.message)
		res.redirect(countlyConfig.path+'/login?message='+req.query.message);
	else
		res.redirect(countlyConfig.path+'/login');
});

app.get(countlyConfig.path+'/dashboard', function (req, res, next) {
    if (!req.session.uid) {
        res.redirect(countlyConfig.path+'/login');
    } else {
        countlyDb.collection('members').findOne({"_id":countlyDb.ObjectID(req.session.uid)}, function (err, member) {
            if (member) {
                var adminOfApps = [],
                    userOfApps = [],
                    countlyGlobalApps = {},
                    countlyGlobalAdminApps = {};

                if (member['global_admin']) {
                    countlyDb.collection('apps').find({}).toArray(function (err, apps) {
                        adminOfApps = apps;
                        userOfApps = apps;

                        countlyDb.collection('graph_notes').find().toArray(function (err, notes) {
                            var appNotes = [];
                            for (var i = 0; i < notes.length; i++) {
                                appNotes[notes[i]["_id"]] = notes[i]["notes"];
                            }

                            for (var i = 0; i < apps.length; i++) {
								apps[i]["notes"] = appNotes[apps[i]["_id"]] || null;
                                countlyGlobalApps[apps[i]["_id"]] = apps[i];
								countlyGlobalApps[apps[i]["_id"]]["_id"] = "" + apps[i]["_id"];
                            }

                            countlyGlobalAdminApps = countlyGlobalApps;
                            renderDashboard();
                        });
                    });
                } else {
                    var adminOfAppIds = [],
                        userOfAppIds = [];

                    if (member.admin_of.length == 1 && member.admin_of[0] == "") {
                        member.admin_of = [];
                    }

                    for (var i = 0; i < member.admin_of.length; i++) {
                        if (member.admin_of[i] == "") {
                            continue;
                        }

                        adminOfAppIds[adminOfAppIds.length] = countlyDb.ObjectID(member.admin_of[i]);
                    }

                    for (var i = 0; i < member.user_of.length; i++) {
                        if (member.user_of[i] == "") {
                            continue;
                        }

                        userOfAppIds[userOfAppIds.length] = countlyDb.ObjectID(member.user_of[i]);
                    }

                    countlyDb.collection('apps').find({ _id:{ '$in':adminOfAppIds } }).toArray(function (err, admin_of) {

                        for (var i = 0; i < admin_of.length; i++) {
                            countlyGlobalAdminApps[admin_of[i]["_id"]] = admin_of[i];
							countlyGlobalAdminApps[admin_of[i]["_id"]]["_id"] = "" + admin_of[i]["_id"];
                        }

                        countlyDb.collection('apps').find({ _id:{ '$in':userOfAppIds } }).toArray(function (err, user_of) {
                            adminOfApps = admin_of;
                            userOfApps = user_of;

                            countlyDb.collection('graph_notes').find({ _id:{ '$in':userOfAppIds } }).toArray(function (err, notes) {
                                var appNotes = [];
                                for (var i = 0; i < notes.length; i++) {
                                    appNotes[notes[i]["_id"]] = notes[i]["notes"];
                                }

                                for (var i = 0; i < user_of.length; i++) {
									user_of[i]["notes"] = appNotes[user_of[i]["_id"]] || null;
                                    countlyGlobalApps[user_of[i]["_id"]] = user_of[i];
									countlyGlobalApps[user_of[i]["_id"]]["_id"] = "" + user_of[i]["_id"];
                                }
                                
                                renderDashboard();
                            });
                        });
                    });
                }

                function renderDashboard() {
                    countlyDb.collection('settings').findOne({}, function (err, settings) {
                        req.session.uid = member["_id"];
                        req.session.gadm = (member["global_admin"] == true);
                        req.session.email = member["email"];
                        res.header('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');

                        delete member["password"];
                        
                        var countlyGlobal = {
                            apps:countlyGlobalApps,
                            admin_apps:countlyGlobalAdminApps,
                            csrf_token:req.session._csrf,
                            member:member,
                            config: req.config,
							plugins:plugins.getPlugins(),
							path:countlyConfig.path || "",
							cdn:countlyConfig.cdn || ""
                        };
                        
                        if (settings && !err) {
                            adminOfApps = sortBy(adminOfApps, settings.appSortList || []);
                            userOfApps = sortBy(userOfApps, settings.appSortList || []);
                        }
                        
                        var toDashboard = {
                            adminOfApps:adminOfApps,
                            userOfApps:userOfApps,
                            member:member,
                            intercom:countlyConfig.web.use_intercom,
                            countlyVersion:COUNTLY_VERSION,
							countlyType: (COUNTLY_TYPE != "777a2bf527a18e0fffe22fb5b3e322e68d9c07a6") ? true : false,
			                production: plugins.getConfig("frontend").production || false,
							plugins:plugins.getPlugins(),
                            config: req.config,
							path:countlyConfig.path || "",
							cdn:countlyConfig.cdn || ""
                        };
                        
                        plugins.callMethod("renderDashboard", {req:req, res:res, next:next, data:{member:member, adminApps:countlyGlobalAdminApps, userApps:countlyGlobalApps, countlyGlobal:countlyGlobal, toDashboard:toDashboard}});

                        res.expose(countlyGlobal, 'countlyGlobal');
                        
                        res.render('dashboard', toDashboard);
                    });
                }
            } else {
                if (req.session) {
                    req.session.uid = null;
                    req.session.gadm = null;
                    req.session.email = null;
                    res.clearCookie('uid');
                    res.clearCookie('gadm');
                    req.session.destroy(function () {});
                }
                res.redirect(countlyConfig.path+'/login');
            }
        });
    }
});

app.get(countlyConfig.path+'/setup', function (req, res, next) {
    countlyDb.collection('members').count({}, function (err, memberCount) {
        if (memberCount) {
            res.redirect(countlyConfig.path+'/login');
        } else {
            res.render('setup', { "csrf":req.session._csrf, path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
        }
    });
});

app.get(countlyConfig.path+'/login', function (req, res, next) {
    if (req.session.uid) {
        res.redirect(countlyConfig.path+'/dashboard');
    } else {
        countlyDb.collection('members').count({}, function (err, memberCount) {
            if (memberCount) {
				if(req.query.message)
					req.flash('info', req.query.message);
                res.render('login', { "message":req.flash('info'), "csrf":req.session._csrf, path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
            } else {
                res.redirect(countlyConfig.path+'/setup');
            }
        });
    }
});

app.get(countlyConfig.path+'/forgot', function (req, res, next) {
    if (req.session.uid) {
        res.redirect(countlyConfig.path+'/dashboard');
    } else {
        res.render('forgot', { "csrf":req.session._csrf, "message":req.flash('info'), path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
    }
});

app.get(countlyConfig.path+'/reset/:prid', function (req, res, next) {
    if (req.params.prid) {
        countlyDb.collection('password_reset').findOne({prid:req.params.prid}, function (err, passwordReset) {
            var timestamp = Math.round(new Date().getTime() / 1000);

            if (passwordReset && !err) {
                if (timestamp > (passwordReset.timestamp + 600)) {
                    req.flash('info', 'reset.invalid');
                    res.redirect(countlyConfig.path+'/forgot');
                } else {
                    res.render('reset', { "csrf":req.session._csrf, "prid":req.params.prid, "message":"", path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
                }
            } else {
                req.flash('info', 'reset.invalid');
                res.redirect(countlyConfig.path+'/forgot');
            }
        });
    } else {
        req.flash('info', 'reset.invalid');
        res.redirect(countlyConfig.path+'/forgot');
    }
});

app.post(countlyConfig.path+'/reset', function (req, res, next) {
    if (req.body.password && req.body.again && req.body.prid) {
        var password = sha1Hash(req.body.password);

        countlyDb.collection('password_reset').findOne({prid:req.body.prid}, function (err, passwordReset) {
            countlyDb.collection('members').update({_id:passwordReset.user_id}, {'$set':{ "password":password }}, function (err, member) {
                plugins.callMethod("passwordReset", {req:req, res:res, next:next, data:member[0]});
                req.flash('info', 'reset.result');
                res.redirect(countlyConfig.path+'/login');
            });

            countlyDb.collection('password_reset').remove({prid:req.body.prid}, function () {});
        });
    } else {
        res.render('reset', { "csrf":req.session._csrf, "prid":req.body.prid, "message":"", path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
    }
});

app.post(countlyConfig.path+'/forgot', function (req, res, next) {
    if (req.body.email) {
        countlyDb.collection('members').findOne({"email":req.body.email}, function (err, member) {
            if (member) {
                var timestamp = Math.round(new Date().getTime() / 1000),
                    prid = sha1Hash(member.username + member.full_name, timestamp);

                countlyDb.collection('password_reset').insert({"prid":prid, "user_id":member._id, "timestamp":timestamp}, {safe:true}, function (err, password_reset) {
                    countlyMail.sendPasswordResetInfo(member, prid);
                    plugins.callMethod("passwordRequest", {req:req, res:res, next:next, data:req.body});
                    res.render('forgot', { "message":"forgot.result", "csrf":req.session._csrf, path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
                });
            } else {
                res.render('forgot', { "message":"forgot.result", "csrf":req.session._csrf, path:countlyConfig.path || "", cdn:countlyConfig.cdn || "" });
            }
        });
    } else {
        res.redirect(countlyConfig.path+'/forgot');
    }
});

app.post(countlyConfig.path+'/setup', function (req, res, next) {
    countlyDb.collection('members').count({}, function (err, memberCount) {
        if (memberCount) {
            res.redirect(countlyConfig.path+'/login');
        } else {
            if (req.body.full_name && req.body.username && req.body.password && req.body.email) {
                var password = sha1Hash(req.body.password);

                countlyDb.collection('members').insert({"full_name":req.body.full_name, "username":req.body.username, "password":password, "email":req.body.email, "global_admin":true}, {safe:true}, function (err, member) {
                    if (countlyConfig.web.use_intercom) {
                        var options = {uri:"https://cloud.count.ly/s", method:"POST", timeout:4E3, json:{email:req.body.email, full_name:req.body.full_name, v:COUNTLY_VERSION, t:COUNTLY_TYPE}};
                        request(options, function(a, c, b) {
                            a = {};
                            a.api_key = md5Hash(member[0]._id + (new Date).getTime());
                            b && (b.in_user_id && (a.in_user_id = b.in_user_id), b.in_user_hash && (a.in_user_hash = b.in_user_hash));

                            countlyDb.collection("members").update({_id:member[0]._id}, {$set:a}, function(err, mem) {
                                plugins.callMethod("setup", {req:req, res:res, next:next, data:member[0]});
                                req.session.uid = member[0]._id;
                                req.session.gadm = !0;
                                req.session.email = member[0].email;
                                res.redirect(countlyConfig.path+"/dashboard")
                            })
                        });
                    } else {
                        a = {};
                        a.api_key = md5Hash(member[0]._id + (new Date).getTime());

                        countlyDb.collection("members").update({_id:member[0]._id}, {$set:a}, function() {
                            req.session.uid = member[0]._id;
                            req.session.gadm = !0;
                            req.session.email = member[0].email;
                            res.redirect(countlyConfig.path+"/dashboard")
                        })
                    }
                });
            } else {
                res.redirect(countlyConfig.path+'/setup');
            }
        }
    });
});

app.post(countlyConfig.path+'/login', function (req, res, next) {
    if (req.body.username && req.body.password) {
        var password = sha1Hash(req.body.password);

        countlyDb.collection('members').findOne({$or: [ {"username":req.body.username}, {"email":req.body.username} ], "password":password}, function (err, member) {
            if (member) {
                plugins.callMethod("loginSuccessful", {req:req, res:res, next:next, data:member});
                if (countlyConfig.web.use_intercom && member['global_admin']) {
                    countlyStats.getOverall(countlyDb, function(statsObj){
                        request({
                            uri:"https://cloud.count.ly/s",
                            method:"POST",
                            timeout:4E3,
                            json:{
                                email:member.email,
                                full_name:member.full_name,
                                v:COUNTLY_VERSION,
                                t:COUNTLY_TYPE,
                                u:statsObj["total-users"],
                                e:statsObj["total-events"],
                                a:statsObj["total-apps"],
                                m:statsObj["total-msg-users"],
                                mc:statsObj["total-msg-created"],
                                ms:statsObj["total-msg-sent"]
                            }
                        }, function(a, c, b) {
                            a = {};
                            b && (b.in_user_id && !member.in_user_id && (a.in_user_id = b.in_user_id), b.in_user_hash && !member.in_user_hash && (a.in_user_hash = b.in_user_hash));
                            Object.keys(a).length && countlyDb.collection("members").update({_id:member._id}, {$set:a}, function() {})
                        });
                    });
                }

                req.session.uid = member["_id"];
                req.session.gadm = (member["global_admin"] == true);
				req.session.email = member["email"];
				if(plugins.getConfig("frontend").session_timeout)
					req.session.expires = Date.now()+plugins.getConfig("frontend").session_timeout;
                res.redirect(countlyConfig.path+'/dashboard');
            } else {
                plugins.callMethod("loginFailed", {req:req, res:res, next:next, data:req.body});
				res.redirect(countlyConfig.path+'/login?message=login.result');
            }
        });
    } else {
        res.redirect(countlyConfig.path+'/login?message=login.result');
    }
});

var auth = express.basicAuth(function(user, pass, callback) {
    var password = sha1Hash(pass);
    countlyDb.collection('members').findOne({$or: [ {"username":user}, {"email":user} ], "password":password}, function (err, member) {
        if(member)
			callback(null, member);
		else
			callback(null, user);
    });
});

app.get(countlyConfig.path+'/api-key', auth, function (req, res, next) {
    if (req.user && req.user._id) {
        plugins.callMethod("apikeySuccessful", {req:req, res:res, next:next, data:req.user});
        res.send(req.user.api_key);
    } else {
        plugins.callMethod("apikeyFailed", {req:req, res:res, next:next, data:{username:req.user}});
        res.send("-1");
    }
});

app.post(countlyConfig.path+'/mobile/login', function (req, res, next) {
    if (req.body.username && req.body.password) {
        var password = sha1Hash(req.body.password);

        countlyDb.collection('members').findOne({$or: [ {"username":req.body.username}, {"email":req.body.username} ], "password":password}, function (err, member) {
            if (member) {
                plugins.callMethod("mobileloginSuccessful", {req:req, res:res, next:next, data:member});
                res.render('mobile/key', { "key": member.api_key || -1 });
            } else {
                plugins.callMethod("mobileloginFailed", {req:req, res:res, next:next, data:req.body});
                res.render('mobile/login', { "message":"login.result", "csrf":req.session._csrf });
            }
        });
    } else {
        res.render('mobile/login', { "message":"login.result", "csrf":req.session._csrf });
    }
});

app.post(countlyConfig.path+'/dashboard/settings', function (req, res, next) {
    if (!req.session.uid) {
        res.end();
        return false;
    }

    if (!isGlobalAdmin(req)) {
        res.end();
        return false;
    }

    var newAppOrder = req.body.app_sort_list;

    if (!newAppOrder || newAppOrder.length == 0) {
        res.end();
        return false;
    }

    countlyDb.collection('settings').update({}, {'$set':{'appSortList':newAppOrder}}, {'upsert':true});
});

app.post(countlyConfig.path+'/apps/icon', function (req, res, next) {
    if (!req.files.app_image || !req.body.app_image_id) {
        res.end();
        return true;
    }

    var tmp_path = req.files.app_image.path,
        target_path = __dirname + '/public/appimages/' + req.body.app_image_id + ".png",
        type = req.files.app_image.type;

    if (type != "image/png" && type != "image/gif" && type != "image/jpeg") {
        fs.unlink(tmp_path, function () {});
        res.send(false);
        return true;
    }
    plugins.callMethod("iconUpload", {req:req, res:res, next:next, data:req.body});
    fs.rename(tmp_path, target_path, function (err) {
        fs.unlink(tmp_path, function () {});
        im.crop({
            srcPath:target_path,
            dstPath:target_path,
            format:'png',
            width:72,
            height:72
        }, function (err, stdout, stderr) {});

        res.send(countlyConfig.path+"/appimages/" + req.body.app_image_id + ".png");
    });
});

app.post(countlyConfig.path+'/user/settings', function (req, res, next) {
    if (!req.session.uid) {
        res.end();
        return false;
    }

    var updatedUser = {};

    if (req.body.username) {
        updatedUser.username = req.body["username"];

        countlyDb.collection('members').findOne({username:req.body.username}, function (err, member) {
            if ((member && member._id != req.session.uid) || err) {
                res.send("username-exists");
            } else {
                if (req.body.old_pwd) {
                    var password = sha1Hash(req.body.old_pwd),
                        newPassword = sha1Hash(req.body.new_pwd);

                    updatedUser.password = newPassword;
                    plugins.callMethod("userSettings", {req:req, res:res, next:next, data:member});
                    countlyDb.collection('members').update({"_id":countlyDb.ObjectID(req.session.uid), "password":password}, {'$set':updatedUser}, {safe:true}, function (err, member) {
                        if (member && !err) {
                            res.send(true);
                        } else {
                            res.send(false);
                        }
                    });
                } else {
                    countlyDb.collection('members').update({"_id":countlyDb.ObjectID(req.session.uid)}, {'$set':updatedUser}, {safe:true}, function (err, member) {
                        if (member && !err) {
                            res.send(true);
                        } else {
                            res.send(false);
                        }
                    });
                }
            }
        });
    } else {
        res.send(false);
        return false;
    }
});

app.post(countlyConfig.path+'/users/check/email', function (req, res, next) {
    if (!req.session.uid || !isGlobalAdmin(req) || !req.body.email) {
        res.send(false);
        return false;
    }

    countlyDb.collection('members').findOne({email:req.body.email}, function (err, member) {
        if (member || err) {
            res.send(false);
        } else {
            res.send(true);
        }
    });
});

app.post(countlyConfig.path+'/users/check/username', function (req, res, next) {
    if (!req.session.uid || !isGlobalAdmin(req) || !req.body.username) {
        res.send(false);
        return false;
    }

    countlyDb.collection('members').findOne({username:req.body.username}, function (err, member) {
        if (member || err) {
            res.send(false);
        } else {
            res.send(true);
        }
    });
});

app.post(countlyConfig.path+'/events/map/edit', function (req, res, next) {
    if (!req.session.uid || !req.body.app_id) {
        res.end();
        return false;
    }

    if (!isGlobalAdmin(req)) {
        countlyDb.collection('members').findOne({"_id":countlyDb.ObjectID(req.session.uid)}, function (err, member) {
            if (!err && member.admin_of && member.admin_of.indexOf(req.body.app_id) != -1) {
                countlyDb.collection('events').update({"_id":countlyDb.ObjectID(req.body.app_id)}, {'$set':{"map":req.body.event_map, "order":req.body.event_order}}, function (err, events) {
                });
                res.send(true);
                return true;
            } else {
                res.send(false);
                return false;
            }
        });
    } else {
        countlyDb.collection('events').update({"_id":countlyDb.ObjectID(req.body.app_id)}, {'$set':{"map":req.body.event_map, "order":req.body.event_order}}, function (err, events) {
        });
        res.send(true);
        return true;
    }
});

function deleteEvent(req, event_key, app_id, callback){
    var updateThese = {
        "$unset": {},
        "$pull": {
            "list": event_key,
            "order": event_key
        }
    };

    if(event_key.indexOf('.') != -1){
        updateThese["$unset"]["map." + event_key.replace(/\./g,':')] = 1;
        updateThese["$unset"]["segments." + event_key.replace(/\./g,':')] = 1;
    }
    else{
        updateThese["$unset"]["map." + event_key] = 1;
        updateThese["$unset"]["segments." + event_key] = 1;
    }

    var collectionNameWoPrefix = crypto.createHash('sha1').update(event_key + app_id).digest('hex');
    if (!isGlobalAdmin(req)) {
        countlyDb.collection('members').findOne({"_id":countlyDb.ObjectID(req.session.uid)}, function (err, member) {
            if (!err && member.admin_of && member.admin_of.indexOf(app_id) != -1) {
                countlyDb.collection('events').update({"_id":countlyDb.ObjectID(app_id)}, updateThese, function (err, events) {
                    if(callback)
                        callback(true);
                });
                countlyDb.collection("events" + collectionNameWoPrefix).drop();
                return true;
            } else {
                if(callback)
                    callback(false);
                return false;
            }
        });
    } else {
        countlyDb.collection('events').update({"_id":countlyDb.ObjectID(app_id)}, updateThese, function (err, events) {
            if(callback)
                callback(true);
        });
        countlyDb.collection("events" + collectionNameWoPrefix).drop();
        return true;
    }
}

app.post(countlyConfig.path+'/events/delete', function (req, res, next) {
    if (!req.session.uid || !req.body.app_id || !req.body.event_key) {
        res.end();
        return false;
    }
    
    deleteEvent(req, req.body.event_key, req.body.app_id, function(result){
        res.send(result);
    })
});

app.post(countlyConfig.path+'/events/delete_multi', function (req, res, next) {
    if (!req.session.uid || !req.body.app_id || !req.body.events) {
        res.end();
        return false;
    }
    req.body.events = JSON.parse(req.body.events);
    async.each(req.body.events, function(key, callback){
        deleteEvent(req, key, req.body.app_id, function(result){
            callback();
        })
    }, function(err, results) {
        res.send(true);
    });
});

app.post(countlyConfig.path+'/graphnotes/create', function (req, res, next) {
    if (!req.session.uid || !req.body.app_id || !req.body.date_id || !req.body.note || req.body.note.length > 50) {
        res.send(false);
        res.end();
        return false;
    }

    if (!isGlobalAdmin(req)) {
        countlyDb.collection('members').findOne({"_id":countlyDb.ObjectID(req.session.uid)}, function (err, member) {
            if (!err && member.user_of && member.user_of.indexOf(req.body.app_id) != -1) {
                createNote();
                return true;
            } else {
                res.send(false);
                return false;
            }
        });
    } else {
        createNote();
        return true;
    }

    function createNote() {
        var noteObj = {},
            sanNote = stringJS(req.body.note).stripTags().s;

        noteObj["notes." + req.body.date_id] = sanNote;

        countlyDb.collection('graph_notes').update({"_id": countlyDb.ObjectID(req.body.app_id)}, { $addToSet: noteObj }, {upsert: true}, function(err, res) {});
        res.send(sanNote);
    }
});

app.post(countlyConfig.path+'/graphnotes/delete', function (req, res, next) {
    if (!req.session.uid || !req.body.app_id || !req.body.date_id || !req.body.note) {
        res.end();
        return false;
    }

    if (!isGlobalAdmin(req)) {
        countlyDb.collection('members').findOne({"_id":countlyDb.ObjectID(req.session.uid)}, function (err, member) {
            if (!err && member.user_of && member.user_of.indexOf(req.body.app_id) != -1) {
                deleteNote();
                return true;
            } else {
                res.send(false);
                return false;
            }
        });
    } else {
        deleteNote();
        return true;
    }

    function deleteNote() {
        var noteObj = {};
        noteObj["notes." + req.body.date_id] = req.body.note;

        countlyDb.collection('graph_notes').update({"_id": countlyDb.ObjectID(req.body.app_id)}, { $pull: noteObj }, function(err, res) {});
        res.send(true);
    }
});

app.listen(countlyConfig.web.port, countlyConfig.web.host  || '');