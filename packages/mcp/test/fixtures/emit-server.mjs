const exitCode = Number(process.argv[2] ?? "0");
process.stdout.write('{"jsonrpc":"2.0","id":"emit-1","result":{"ok":true}}' + "\n");
process.stdout.write("this is not json\n");
process.stderr.write("emit-server diagnostic output\n");
process.exitCode = exitCode;
