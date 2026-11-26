// Command sshexec 临时验证/部署工具：用密码走 SSH 执行一条命令（密码取 QX_PASS）。
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"golang.org/x/crypto/ssh"
)

func main() {
	host := flag.String("host", "", "目标主机")
	user := flag.String("user", "", "用户名")
	port := flag.Int("port", 22, "端口")
	cmd := flag.String("cmd", "", "要执行的命令")
	flag.Parse()

	pass := os.Getenv("QX_PASS")
	if pass == "" {
		fmt.Fprintln(os.Stderr, "缺少环境变量 QX_PASS")
		os.Exit(2)
	}
	cfg := &ssh.ClientConfig{
		User: *user,
		Auth: []ssh.AuthMethod{
			ssh.Password(pass),
			ssh.KeyboardInteractive(func(user, instruction string, questions []string, echos []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range questions {
					answers[i] = pass
				}
				return answers, nil
			}),
		},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}
	client, err := ssh.Dial("tcp", fmt.Sprintf("%s:%d", *host, *port), cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "DIAL_ERR: "+err.Error())
		os.Exit(1)
	}
	defer client.Close()
	s, err := client.NewSession()
	if err != nil {
		fmt.Fprintln(os.Stderr, "SESSION_ERR: "+err.Error())
		os.Exit(1)
	}
	defer s.Close()
	s.Stdin = os.Stdin
	s.Stdout = os.Stdout
	s.Stderr = os.Stderr
	if err := s.Run(*cmd); err != nil {
		fmt.Fprintln(os.Stderr, "CMD_ERR: "+err.Error())
		os.Exit(3)
	}
}
