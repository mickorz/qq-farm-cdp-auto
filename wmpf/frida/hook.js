const getMainModule = (version) => {
    if (version >= 13331) {
        return Process.findModuleByName("flue.dll");
    }
    return Process.findModuleByName("WeChatAppEx.exe");
};

const patchCDPFilter = (base, config) => {
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    // 新版结构：通过 CastToJson 桥接，用 Interceptor.replace 替换 CDP 过滤函数
    if (config.CastToJsonHookOffset) {
        const castToJsonFunc = new NativeFunction(
            base.add(config.CastToJsonHookOffset),
            "pointer",
            ["pointer", "pointer"],
        );
        const callback = new NativeCallback(
            function (thiz, jsonOut, cborInput) {
                castToJsonFunc(jsonOut, cborInput);
                return jsonOut;
            },
            "pointer",
            ["pointer", "pointer", "pointer"],
        );
        Interceptor.replace(base.add(config.CDPFilterHookOffset), callback);
        send("[patch] CDP filter replaced with CastToJson bridge");
        return;
    }

    // 旧版结构：Interceptor.attach 拦截 CDP 过滤，将 type=6 改写为 0
    const offset = config.CDPFilterHookOffset;
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            send(
                `[patch] CDP filter on enter, original value of input: ${args[0].readPointer()}`,
            );
            this.inputValue = args[0];
        },
        onLeave(retval) {
            const inputValue = this.inputValue.readPointer();
            if (inputValue.isNull() || inputValue.add(8).isNull()) {
                // 数值可能为空，跳过避免崩溃
                return;
            }

            send(
                `[patch] CDP filter on leave, patch input, now value: ${inputValue}; ` +
                    `*(input + 8) = ${inputValue.add(8).readU32()}`,
            );
            if (inputValue.add(8).readU32() == 6) {
                inputValue.add(8).writeU32(0x0);
            }
        },
    });
};

const hookOnLoadScene = (a1, config) => {
    // 旧版结构：SceneOffsets + ScenePathOffsets 双数组定位场景
    if (config.SceneOffsets) {
        const sceneOffsets = config.SceneOffsets;
        const [configOffset, sceneRootOffset, sceneValueOffset] =
            config.ScenePathOffsets || [56, 8, 16];
        const miniappConfigPtr = a1
            .add(configOffset)
            .readPointer()
            .add(sceneOffsets[0])
            .readPointer();
        const miniappScenePtr = miniappConfigPtr
            .add(sceneRootOffset)
            .readPointer()
            .add(sceneOffsets[1])
            .readPointer()
            .add(sceneValueOffset)
            .readPointer()
            .add(sceneOffsets[2]);
        send(`[hook] scene: ${miniappScenePtr.readInt()}`);

        // 1000: from issue #83 <-- will crash the process
        // 1007: from issue #80
        // 1008: from issue #53
        // 1027: from issue #78
        // 1035: from issue #78
        // 1053: from issue #25
        // 1074: from issue #32
        // 1145: from search
        // 1178: from phone (issue #117)
        // 1256: from recent
        // 1260: from frequently used
        // 1302: from services
        // 1308: minigame?
        const sceneNumberArray = [
            1005, 1007, 1008, 1027, 1035, 1053, 1074, 1145, 1178, 1256, 1260,
            1302, 1308,
        ];
        if (!sceneNumberArray.includes(miniappScenePtr.readInt())) {
            return;
        }
        send("[hook] hook scene condition -> 1101");
        miniappScenePtr.writeInt(1101);
        return;
    }

    // 新版结构：MiniAppConfigStructOffsets 嵌套对象定位场景
    const structOffsets = config.MiniAppConfigStructOffsets;
    const launchConfigOffsets = structOffsets.LaunchConfigOffsets;
    const remoteDebugConfigOffsets = structOffsets.RemoteDebugConfigOffsets;
    const miniappLaunchConfigPtr = a1
        .add(launchConfigOffsets[0])
        .readPointer()
        .add(launchConfigOffsets[1])
        .readPointer()
        .add(launchConfigOffsets[2])
        .readPointer();
    const remoteDebugConfigPtr = miniappLaunchConfigPtr
        .add(remoteDebugConfigOffsets[0])
        .readPointer()
        .add(remoteDebugConfigOffsets[1])
        .readPointer();
    const miniappScenePtr = remoteDebugConfigPtr.add(
        structOffsets.SceneOffset,
    );

    // 1000: from issue #83 <-- will crash the process
    // 1007: from issue #80
    // 1008: from issue #53
    // 1011: scan QR code
    // 1012: recognize QR code from long-pressed image (issue #128)
    // 1027: from issue #78
    // 1035: from issue #78
    // 1037: opened from another mini program
    // 1053: from issue #25
    // 1074: from issue #32
    // 1145: from search
    // 1178: from phone (issue #117)
    // 1256: from recent
    // 1260: from frequently used
    // 1302: from services
    // 1308: minigame?
    const sceneNumberArray = [
        1005, 1007, 1008, 1011, 1012, 1027, 1035, 1037, 1053, 1074, 1145, 1178,
        1256, 1260, 1302, 1308,
    ];
    if (!sceneNumberArray.includes(miniappScenePtr.readInt())) {
        return;
    }
    send(`[hook] scene: ${miniappScenePtr.readInt()}`);
    send("[hook] hook scene condition -> 1101");
    miniappScenePtr.writeInt(1101);

    // 设置 WebSocket 回连地址，指向本地 debug server
    const websocketUrl = "@@WS_URL@@";
    const websocketUrlStringPtr = miniappLaunchConfigPtr.add(
        structOffsets.WebSocketURLStringOffset,
    );
    const stringMarker = websocketUrlStringPtr.add(23).readS8();
    if (stringMarker < 0) {
        // 长字符串表示：数据指针 + 长度 + 容量(高位标记)
        websocketUrlStringPtr.readPointer().writeUtf8String(websocketUrl);
        websocketUrlStringPtr.add(8).writeU64(websocketUrl.length);
    } else {
        // 短字符串表示：23 字节内联 + 1 字节长度
        websocketUrlStringPtr.writeUtf8String(websocketUrl);
        websocketUrlStringPtr.add(23).writeU8(websocketUrl.length);
    }
    send(`[hook] websocket url -> ${websocketUrl}`);

    const remoteDebugModePtr = remoteDebugConfigPtr.add(
        structOffsets.RemoteDebugModeOffset,
    );
    send(`[hook] remote debug mode: ${remoteDebugModePtr.readInt()} -> 1`);
    remoteDebugModePtr.writeInt(1);
};

const patchOnLoadStart = (base, config) => {
    // xref: AppletIndexContainer::OnLoadStart
    Interceptor.attach(base.add(config.LoadStartHookOffset), {
        onEnter(args) {
            send(
                `[inteceptor] AppletIndexContainer::OnLoadStart onEnter, ` +
                    `indexContainer.this: ${args[0]}`,
            );
            // 将 debug_flag 写为 0x1
            if (args[1].and(0xff).toInt32() !== 1) {
                args[1] = args[1].and(ptr("0xffffffffffffff00")).or(1);
            }
            // 处理 onLoadStart 参数，定位并改写场景
            hookOnLoadScene(args[0], config);
        },
        onLeave(retval) {
            // do nothing
        },
    });
};

const parseConfig = () => {
    const rawConfig = `@@CONFIG@@`;
    if (rawConfig.includes("@@")) {
        // test addresses
        return {
            Version: 18955,
            LoadStartHookOffset: "0x25B52C0",
            CDPFilterHookOffset: "0x30248B0",
            SceneOffsets: [1408, 1344, 488],
            ScenePathOffsets: [56, 8, 16],
        };
    }
    return JSON.parse(rawConfig);
};

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    patchOnLoadStart(mainModule.base, config);
    patchCDPFilter(mainModule.base, config);
};

main();
