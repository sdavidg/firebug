/* See license.txt for terms of usage */

define([
    "firebug/firebug",
    "firebug/lib/trace",
    "firebug/lib/object",
    "firebug/lib/options",
    "firebug/lib/events",
],
function(Firebug, FBTrace, Obj, Options, Events) {

// ********************************************************************************************* //
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

var TraceConn = FBTrace.to("DBG_CONNECTION");
var TraceError = FBTrace.to("DBG_ERRORS");

Cu.import("resource://gre/modules/devtools/dbg-client.jsm");
Cu.import("resource://gre/modules/devtools/dbg-server.jsm");

// ********************************************************************************************* //
// Module Implementation

/**
 * @module This object is responsible for DebuggerClient initialization. DebuggerClient
 * represents the connection to the server side.
 */
var DebuggerClientModule = Obj.extend(Firebug.Module,
/** @lends DebuggerClientModule */
{
    client: null,
    isRemoteDebugger: false,
    tabMap: [],

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Initialization

    initializeUI: function()
    {
        Firebug.Module.initializeUI.apply(this, arguments);

        this.onConnect = Obj.bind(this.onConnect, this);
        this.onDisconnect = Obj.bind(this.onDisconnect, this);

        this.onTabNavigated = Obj.bind(this.onTabNavigated, this);
        this.onTabDetached = Obj.bind(this.onTabDetached, this);

        // Connect the server in 'initializeUI' so, listeners from other modules can
        // be registered in 'initialize'.
        this.connect();
    },

    shutdown: function()
    {
        Firebug.Module.shutdown.apply(this, arguments);

        this.disconnect();
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    connect: function()
    {
        // Initialize the server to allow connections through pipe transport.
        if (!this.isRemoteDebugger)
        {
            DebuggerServer.init(function () { return true; });
            DebuggerServer.addBrowserActors();
        }

        this.transport = (this.isRemoteDebugger) ?
            debuggerSocketConnect(Options.get("remoteHost"), Options.get("remotePort")) :
            DebuggerServer.connectPipe();

        Firebug.debuggerClient = this.client = new DebuggerClient(this.transport);

        // Hook packet transport to allow tracing.
        if (FBTrace.DBG_CONNECTION)
            this.hookPacketTransport(this.transport);

        this.client.addListener("tabNavigated", this.onTabNavigated);
        this.client.addListener("tabDetached", this.onTabDetached);

        // Connect to the server.
        this.client.connect(this.onConnect);
    },

    disconnect: function()
    {
        this.client.removeListener("tabNavigated", this.onTabNavigated);
        this.client.removeListener("tabDetached", this.onTabDetached);

        // Disconnect from the server.
        this.client.close(this.onDisconnect);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Hooks

    onConnect: function(type, traits)
    {
        this.dispatch("onConnect", [this.client]);

        this.attachCurrentTab(Firebug.currentContext);
    },

    onDisconnect: function()
    {
        this.dispatch("onDisconnect", [this.client]);
    },

    onTabNavigated: function()
    {
        this.dispatch("onTabNavigated", arguments);
    },

    onTabDetached: function()
    {
        this.dispatch("onThreadDetached", arguments);
        this.dispatch("onTabDetached", arguments);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Context

    initContext: function(context, persistedState)
    {
        if (persistedState)
        {
            context.tabClient = persistedState.tabClient;
            context.activeThread = persistedState.activeThread;
        }

        // Attach remote tab.
        // xxxHonza: doesn't have to be the current one.
        if (this.client && this.client._connected)
            this.attachCurrentTab(context);
    },

    destroyContext: function(context, persistedState)
    {
        persistedState.tabClient = context.tabClient;
        persistedState.activeThread = context.activeThread;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Tab

    attachCurrentTab: function(context)
    {
        // Context already attached (page just reloaded).
        if (context.tabClient && context.activeThread)
        {
            this.dispatch("onTabAttached", [context]);
            this.dispatch("onThreadAttached", [context]);
            return;
        }

        var self = this;
        this.client.listTabs(function(response)
        {
            var tabGrip = response.tabs[response.selected];
            self.attachTab(context, tabGrip.actor);
        });
    },

    attachTab: function(context, tabActor)
    {
        if (context.tabClient)
        {
            this.attachThread(context, response.threadActor);
            return;
        }

        var self = this;
        this.client.attachTab(tabActor, function(response, tabClient)
        {
            if (!tabClient)
            {
                TraceError.sysout("ERROR: No tab client found!");
                return;
            }

            context.tabClient = tabClient;

            self.dispatch("onTabAttached", [context]);

            self.attachThread(context, response.threadActor);
        });
    },

    attachThread: function(context, threadActor)
    {
        var self = this;
        this.client.attachThread(threadActor, function(response, threadClient)
        {
            if (!threadClient)
            {
                TraceError.sysout("Couldn't attach to thread: " + response.error);
                return;
            }

            context.activeThread = threadClient;

            self.dispatch("onThreadAttached", [context]);

            threadClient.resume();
        });
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Event Source

    dispatch: function(eventName, args)
    {
        FBTrace.sysout("debuggerClientModule.dispatch; " + eventName, args);

        Firebug.Module.dispatch.apply(this, arguments);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Debugging

    hookPacketTransport: function(transport)
    {
        var self = this;

        transport.hooks =
        {
            onPacket: function onPacket(packet)
            {
                TraceConn.sysout("PACKET RECEIVED; " + JSON.stringify(packet), packet);
                self.client.onPacket(packet);
            },

            onClosed: function(status)
            {
                self.client.onClosed(packet);
            }
        };

        var send = this.transport.send;
        this.transport.send = function(packet)
        {
            TraceConn.sysout("PACKET SEND " + JSON.stringify(packet), packet);

            send.apply(self.transport, arguments);
        }
    }
});

// ********************************************************************************************* //
// Registration

Firebug.registerModule(DebuggerClientModule);

return DebuggerClientModule;

// ********************************************************************************************* //
});
