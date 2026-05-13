# Loaded by every zsh process. Keep this tiny and side-effect free.

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

op_ssh_agent_sock="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
if [ -S "$op_ssh_agent_sock" ]; then
  export SSH_AUTH_SOCK="$op_ssh_agent_sock"
fi
unset op_ssh_agent_sock
