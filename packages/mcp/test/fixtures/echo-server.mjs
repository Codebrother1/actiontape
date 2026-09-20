let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let index = buffered.indexOf("\n");
  while (index !== -1) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    process.stdout.write(line + "\n");
    index = buffered.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffered.length > 0) {
    process.stdout.write(buffered + "\n");
  }
});
